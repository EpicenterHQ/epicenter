/**
 * Focus selection: which saved phrases a session actually puts in play.
 *
 * This is a pure selector over the shared pool, not a scheduler. It reads
 * `stage` and `createdAt`, writes nothing, stores nothing, and has no notion of
 * "due". Run it twice on the same pool and you get the same answer; run it after
 * a session and nothing has changed, because a session never marks a phrase
 * practiced (ADR-0102 refuses counters and intervals, and the mission refuses
 * SRS outright).
 *
 * The cap is the load-bearing part. A tutor handed forty target phrases writes a
 * vocabulary list; handed five, it writes a conversation. So every focus set is
 * capped, the cap is per-intent, and the cap is enforced here rather than hoped
 * for in a prompt.
 */

import type { SavedPhrase } from './saved.ts';

/**
 * Practice deliberately uses targets, so its set is small enough that every
 * phrase can plausibly appear in one sitting.
 */
export const PRACTICE_FOCUS_CAP = 5;

/**
 * Revisit compiles rather than drills, so it can carry a wider set: the phrases
 * are context for "where were we", not a checklist to exhaust.
 */
export const REVISIT_FOCUS_CAP = 8;

/** Chat and Conversation put no phrases in play at all. */
export const NO_FOCUS_CAP = 0;

/** The cap each opening enforces. Exported so a UI can show it honestly. */
export const FOCUS_CAPS = {
	chat: NO_FOCUS_CAP,
	conversation: NO_FOCUS_CAP,
	practice: PRACTICE_FOCUS_CAP,
	revisit: REVISIT_FOCUS_CAP,
} as const;

/**
 * Deterministic order: unlearned before half-learned, then oldest first, then by
 * id. The id tiebreak means two phrases saved in the same millisecond still sort
 * stably, which is what makes the selection reproducible across devices.
 */
const STAGE_ORDER = { new: 0, understood: 1, usable: 2 } as const;

function byStageThenAge(a: SavedPhrase, b: SavedPhrase): number {
	const stage = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
	if (stage !== 0) return stage;
	const age = a.createdAt - b.createdAt;
	if (age !== 0) return age;
	return a.id.localeCompare(b.id);
}

/**
 * The phrases Practice puts in play: everything not yet marked `usable`, newest
 * material first in the acquisition sense (`new` ahead of `understood`), capped.
 *
 * A `usable` phrase is excluded because the human said they can already produce
 * it. That is the only retirement rule, and the human owns it; there is no decay
 * and no re-entry schedule.
 */
export function selectPracticeFocus(
	phrases: SavedPhrase[],
	{ cap = PRACTICE_FOCUS_CAP }: { cap?: number } = {},
): SavedPhrase[] {
	return phrases
		.filter((phrase) => phrase.stage !== 'usable')
		.sort(byStageThenAge)
		.slice(0, Math.max(0, cap));
}

/**
 * The phrases Revisit puts in play.
 *
 * With a topic, the pool is narrowed to phrases that actually appeared in the
 * sessions being revisited, so "let's go back to ordering food" brings back the
 * food phrases and nothing else. Without a topic, it falls back to `understood`
 * phrases: the ones you recognize but cannot yet produce, which is exactly the
 * pile worth returning to.
 *
 * Note what this does *not* do: it does not read a stored link from a phrase to
 * the session it was saved in. ADR-0102 refuses that provenance column, so
 * relevance is recovered by matching phrase text against transcript text at read
 * time. See the README tradeoff on why that is enough here.
 */
export function selectRevisitFocus(
	phrases: SavedPhrase[],
	{
		transcript,
		cap = REVISIT_FOCUS_CAP,
	}: { transcript?: string; cap?: number } = {},
): SavedPhrase[] {
	const pool =
		transcript === undefined
			? phrases.filter((phrase) => phrase.stage === 'understood')
			: phrases.filter(
					(phrase) =>
						phrase.stage !== 'usable' && transcript.includes(phrase.text),
				);
	return pool.sort(byStageThenAge).slice(0, Math.max(0, cap));
}
