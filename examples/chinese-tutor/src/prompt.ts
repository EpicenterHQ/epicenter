/**
 * Prompt composition: one tutor persona, plus at most one session block.
 *
 * Every session in this prototype runs under the same `TUTOR_PROMPT`. What an
 * opening changes is a single appended block naming what *this* session is for.
 * That is the structural claim being tested: the surfaces are not four tutors,
 * they are one tutor handed one extra paragraph.
 *
 * Two rules hold the shape together, and both are asserted in the tests:
 *
 *  1. **At most one block.** A composed prompt carries exactly zero or one
 *     `## This session:` header, so a Practice block can never ride along inside
 *     a Revisit session.
 *  2. **Targets live only in the system layer.** The focus phrases are named
 *     here and nowhere else. They never appear in the visible opening turn, so
 *     they never enter the persisted transcript, so a later turn's model memory
 *     is never a vocabulary list the tutor parrots back (ADR-0047: the durable
 *     transcript *is* the model's memory).
 */

import type { SavedPhrase } from './saved.ts';

/**
 * The Chinese tutor persona. Chinese-focused and bilingual by design: English
 * carries explanation, Chinese carries the language being learned.
 *
 * The "write plain text" rule is what makes the pinyin overlay possible. The
 * message is stored verbatim and fed back as memory, so a reading baked into the
 * text would poison later turns and would have to be stripped at the save, the
 * prompt, and the display boundary (ADR-0105). The client derives readings
 * instead; see `render.ts`.
 */
export const TUTOR_PROMPT = `You are a Chinese tutor. You answer in mixed Chinese and English.

Guidelines:
- Use English for explanations, transitions, and meta-commentary.
- Use Mandarin Chinese in simplified characters (简体字) for vocabulary, example sentences, and anything the learner should absorb. Never use traditional characters.
- Write plain text only. Never add pinyin, phonetic readings, tone numbers, or any romanization: the client renders pinyin above the characters automatically, and a reading written into your answer would corrupt it.
- Present Chinese inline and naturally, e.g. "The word 咖啡 is what you'd use here."
- Adjust difficulty from context clues in what the learner writes.
- Be conversational and encouraging.`;

/** The one header shape a session block may use. */
const BLOCK_HEADER = '## This session:';

/** Each opening's block header, for display and for the isolation assertion. */
export const INTENT_BLOCK_HEADERS = {
	conversation: `${BLOCK_HEADER} open conversation`,
	practice: `${BLOCK_HEADER} practice`,
	revisit: `${BLOCK_HEADER} revisit`,
} as const;

/** Count the session blocks in a composed prompt. Must never exceed one. */
export function countSessionBlocks(systemPrompt: string): number {
	return systemPrompt.split(BLOCK_HEADER).length - 1;
}

/** `TUTOR_PROMPT` alone, or with one block appended. */
export function composeSystemPrompt(block: string | null): string {
	return block === null ? TUTOR_PROMPT : `${TUTOR_PROMPT}\n\n${block}`;
}

/** Chinese enumeration comma, so a list of phrases reads as Chinese would write it. */
function list(phrases: SavedPhrase[]): string {
	return phrases.map((phrase) => phrase.text).join('、');
}

/**
 * Open conversation: follow the learner.
 *
 * This block names no phrases on purpose, and says so out loud, because the
 * failure mode of a tutor that has *seen* a vocabulary list is that it steers
 * toward it. Normal conversation being genuinely normal is the requirement.
 */
export function buildConversationBlock(): string {
	return [
		INTENT_BLOCK_HEADERS.conversation,
		'The learner wants to talk, not study. Follow wherever they take it and let the conversation set its own subject.',
		'Do not steer toward vocabulary, do not quiz, and do not work from any word list. Correct a mistake only when it blocks understanding, briefly, and then carry on with what they were saying.',
	].join('\n');
}

/**
 * Practice: deliberately use a small target set.
 *
 * The two roles are read off `stage`, the human-set dial, at composition time.
 * Nothing is stored and nothing is scheduled: a phrase moves from "meet it" to
 * "produce it" only when the learner marks it `understood` themselves.
 */
export function buildPracticeBlock(focus: SavedPhrase[]): string | null {
	if (focus.length === 0) return null;

	const toIntroduce = focus.filter((phrase) => phrase.stage === 'new');
	const toElicit = focus.filter((phrase) => phrase.stage === 'understood');

	const lines = [
		INTENT_BLOCK_HEADERS.practice,
		'The learner asked to practice what they are working on. Build situations where the phrases below belong, and use them there.',
		'Do not drill them, do not list them, and do not announce that you are using them. If a phrase does not fit naturally in this conversation, leave it out rather than forcing it.',
	];
	if (toIntroduce.length > 0) {
		lines.push(
			`Introduce these in your own lines, with a brief inline gloss the first time: ${list(toIntroduce)}。`,
		);
	}
	if (toElicit.length > 0) {
		lines.push(
			`Set up openings where the learner would naturally need to say these themselves, then let them supply the phrase. Invite, but do not say it for them: ${list(toElicit)}。`,
		);
	}
	return lines.join('\n');
}

/**
 * Revisit: resume a specific thread.
 *
 * Both halves are optional and the block collapses to `null` when neither is
 * present, so a Revisit with no history behaves as plain chat rather than as a
 * session pretending to remember something.
 */
export function buildRevisitBlock({
	excerpt,
	focus,
	topic,
}: {
	excerpt: string;
	focus: SavedPhrase[];
	topic?: string;
}): string | null {
	if (excerpt.length === 0 && focus.length === 0) return null;

	const lines = [
		INTENT_BLOCK_HEADERS.revisit,
		topic === undefined
			? 'The learner is picking up an earlier thread. Resume it rather than starting over, and do not recap what they already covered unless they ask.'
			: `The learner is returning to an earlier thread about "${topic}". Resume it rather than starting over, and do not recap what they already covered unless they ask.`,
	];
	if (excerpt.length > 0) {
		lines.push('', 'What was said before:', excerpt);
	}
	if (focus.length > 0) {
		lines.push(
			'',
			`These saved phrases came up in that thread. Work them back in where they fit, without drilling them: ${list(focus)}。`,
		);
	}
	return lines.join('\n');
}
