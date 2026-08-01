/**
 * The reading overlay: per-character pinyin over Han, and nothing else.
 *
 * A reading is a client-side derived view over clean message text (ADR-0105):
 * the tutor writes plain prose, the message is stored and fed back to the model
 * verbatim, and pinyin is rendered on top through the `Romanizer`/`Segment`/
 * `<ruby>` seam in `@epicenter/ui/markdown`. Pure, synchronous, and lazily
 * loaded the first time a Chinese passage is actually read, so the pinyin-pro
 * dictionary is fetched (a code-split import, browser-cached) only on demand.
 *
 * Deterministic by design: no model call, no network, no round-trip validation.
 * That is possible because Han is lexically complete: each character has a fixed
 * reading a dictionary resolves, with heteronyms handled by frequency and
 * context, which `pinyin-pro` does.
 *
 * One language, so one romanizer (ADR-0195). The ordered provider registry, its
 * per-script dispatch, and the composer are gone along with the multilingual
 * tutor that needed them. Serving a second language now costs a second app, not
 * a provider file and a registry line; that is the deliberate trade.
 */

import {
	identityRomanizer,
	type Romanizer,
	type Segment,
} from '@epicenter/ui/markdown';

/** A run of Han ideographs (simplified + traditional). Global: rebuilt per call
 * for the stateful `.exec` walk in {@link createPinyinRomanizer}. */
const HAN_RUN = /[一-鿿㐀-䶿豈-﫿]+/g;
/** One Han ideograph. Non-global, safe for `.test`. */
const HAS_HAN = /[一-鿿㐀-䶿豈-﫿]/;
/** Kana or hangul. Their presence marks a passage as Japanese or Korean, where
 * Han shared with Chinese takes a non-Mandarin reading (今日 is `kyō`, not the
 * Mandarin reading of 今 + 日). Pinyin abstains when they appear so shared Han is
 * never stamped with a wrong reading: a missing reading is safe, a wrong one
 * teaches a wrong sound. ADR-0105's invariant, preserved by ADR-0195. */
const HAS_KANA_OR_HANGUL = /[぀-ヿ가-힣]/;

type PinyinFn = typeof import('pinyin-pro').pinyin;

/**
 * Per-character pinyin for Han runs; every other run (Latin, punctuation, or any
 * text carrying kana/hangul) passes through with no reading. Concatenating every
 * `segment.text` reproduces the input exactly. Built around a loaded `pinyin`
 * fn so the pinyin-pro dictionary loads lazily (see {@link resolveRomanizer}).
 */
export function createPinyinRomanizer(pinyin: PinyinFn): Romanizer {
	return (text) => {
		if (HAS_KANA_OR_HANGUL.test(text)) return [{ text }];
		const segments: Segment[] = [];
		const regex = new RegExp(HAN_RUN);
		let lastIndex = 0;
		let match: RegExpExecArray | null = regex.exec(text);
		while (match !== null) {
			if (match.index > lastIndex) {
				segments.push({ text: text.slice(lastIndex, match.index) });
			}
			const run = match[0];
			const readings = pinyin(run, { type: 'array' });
			let charIndex = 0;
			for (const char of run) {
				segments.push({
					text: char,
					reading: readings[charIndex] || undefined,
				});
				charIndex++;
			}
			lastIndex = match.index + run.length;
			match = regex.exec(text);
		}
		if (lastIndex < text.length) {
			segments.push({ text: text.slice(lastIndex) });
		}
		return segments;
	};
}

/** One load, shared across every message that needs it. */
let loading: Promise<Romanizer> | null = null;
function loadPinyinRomanizer(): Promise<Romanizer> {
	loading ??= import('pinyin-pro').then(({ pinyin }) =>
		createPinyinRomanizer(pinyin),
	);
	return loading;
}

/**
 * The romanizer for one settled message. Pure local work, no network beyond the
 * one code-split dictionary import. Resolves to the identity romanizer for text
 * with no Chinese to read, so the caller can inject the result without a branch
 * and a Latin-only conversation never pays for the dictionary.
 */
export async function resolveRomanizer(text: string): Promise<Romanizer> {
	const hasChineseToRead = HAS_HAN.test(text) && !HAS_KANA_OR_HANGUL.test(text);
	if (!hasChineseToRead) return identityRomanizer;
	return loadPinyinRomanizer();
}
