/**
 * The derived view: clean text in, annotated tokens out.
 *
 * Nothing here is ever stored. The tutor writes plain text, the store holds that
 * plain text verbatim, and both overlays (pinyin readings and saved-phrase
 * highlighting) are computed at render time from the message plus the current
 * phrase pool. Turn an overlay off and it costs nothing; change a phrase's stage
 * and every past message re-highlights on the next render, because there was
 * never an annotation to go stale.
 *
 * That is what keeps ADR-0105's rule cheap rather than expensive: a reading
 * written into the message would be conversation memory the model reads back on
 * the next turn, and it would have to be stripped at the save boundary, the
 * prompt boundary, and the highlight boundary. Deriving it costs one pure
 * function.
 *
 * Both overlays are deterministic. `pinyin-pro` resolves Han from a bundled
 * per-character dictionary with no model call, no network, and no cache, so the
 * failure mode is a missing reading, never a wrong one. Rendering the same
 * message twice always produces the same tokens.
 */

import { pinyin } from 'pinyin-pro';
import type { SavedPhrase } from './saved.ts';

/** A run of Han ideographs (simplified and traditional, BMP). */
const HAN_RUN = /[一-鿿㐀-䶿豈-﫿]+/g;

/**
 * One rendered token. `text` is always a verbatim slice of the input, so
 * `tokens.map((t) => t.text).join('')` reproduces the message exactly.
 */
export type RenderedToken = {
	text: string;
	/** The reading, when this token is a single Han character and pinyin is on. */
	pinyin?: string;
	/** The saved phrase this token belongs to, when highlighting is on. */
	phrase?: SavedPhrase;
};

export type RenderOptions = {
	/** Render pinyin over Han. Defaults to on; this is the Show readings toggle. */
	pinyin?: boolean;
	/**
	 * The saved phrases to mark. Omitted or empty means no highlighting, which
	 * is the whole implementation of the highlight toggle.
	 */
	phrases?: SavedPhrase[];
};

/** One run of the message: plain text, or a stretch matching a saved phrase. */
type PhraseSegment = { text: string; phrase?: SavedPhrase };

/**
 * Split by saved phrase, longest match wins at each position.
 *
 * Chinese is unspaced, so there is no token boundary to align to and matching
 * has to be dictionary-driven. Longest-first is the standard heuristic and is
 * right for a personal list: if both 学 and 学习 are saved, 学习 wins.
 */
function splitByPhrase(
	text: string,
	phrases: SavedPhrase[],
): PhraseSegment[] {
	if (phrases.length === 0) return [{ text }];

	const byText = new Map(phrases.map((phrase) => [phrase.text, phrase]));
	const longest = Math.max(...phrases.map((phrase) => phrase.text.length));

	const segments: PhraseSegment[] = [];
	let pending = '';
	let index = 0;
	while (index < text.length) {
		let matched: SavedPhrase | undefined;
		for (
			let length = Math.min(longest, text.length - index);
			length >= 1;
			length -= 1
		) {
			const candidate = byText.get(text.slice(index, index + length));
			if (candidate) {
				matched = candidate;
				break;
			}
		}
		if (!matched) {
			pending += text.slice(index, index + 1);
			index += 1;
			continue;
		}
		if (pending) {
			segments.push({ text: pending });
			pending = '';
		}
		segments.push({ text: matched.text, phrase: matched });
		index += matched.text.length;
	}
	if (pending) segments.push({ text: pending });
	return segments;
}

/**
 * Attach a reading to each Han character in one segment; everything else (Latin,
 * punctuation, whitespace) passes through as a single unread token.
 *
 * Per character rather than per word because that is where a reading belongs
 * visually: pinyin sits over the glyph it reads.
 */
function readHan(
	segment: PhraseSegment,
	withPinyin: boolean,
): RenderedToken[] {
	const carry = segment.phrase === undefined ? {} : { phrase: segment.phrase };
	if (!withPinyin) return [{ text: segment.text, ...carry }];

	const tokens: RenderedToken[] = [];
	const regex = new RegExp(HAN_RUN);
	let lastIndex = 0;
	let match = regex.exec(segment.text);
	while (match !== null) {
		if (match.index > lastIndex) {
			tokens.push({ text: segment.text.slice(lastIndex, match.index), ...carry });
		}
		const run = match[0];
		const readings = pinyin(run, { type: 'array' });
		let charIndex = 0;
		for (const char of run) {
			const reading = readings[charIndex];
			tokens.push({
				text: char,
				...(reading ? { pinyin: reading } : {}),
				...carry,
			});
			charIndex += 1;
		}
		lastIndex = match.index + run.length;
		match = regex.exec(segment.text);
	}
	if (lastIndex < segment.text.length) {
		tokens.push({ text: segment.text.slice(lastIndex), ...carry });
	}
	return tokens;
}

/**
 * Render one clean message into annotated tokens. Pure, synchronous, and total:
 * every input produces tokens whose text concatenates back to the input.
 */
export function renderMessage(
	text: string,
	{ pinyin: withPinyin = true, phrases = [] }: RenderOptions = {},
): RenderedToken[] {
	if (text.length === 0) return [];
	return splitByPhrase(text, phrases).flatMap((segment) =>
		readHan(segment, withPinyin),
	);
}

/** The invariant every overlay must preserve: rendering never changes the text. */
export function tokensToText(tokens: RenderedToken[]): string {
	return tokens.map((token) => token.text).join('');
}
