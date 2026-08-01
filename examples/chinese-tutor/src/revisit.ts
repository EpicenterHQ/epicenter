/**
 * Revisit context: compile prior sessions into a short excerpt the tutor can
 * pick up from.
 *
 * The mission's constraint drives the whole shape here: the user may return to
 * *specific topics*, so there is no "yesterday's room" to reopen. A revisit is a
 * search over conversation history, and its result is an excerpt, never a
 * pointer to one canonical session.
 *
 * Like focus selection this is pure and capped. A model handed twenty full
 * transcripts loses the thread; handed a few recent exchanges it resumes. So the
 * excerpt is bounded twice: how many sessions, and how much of each.
 */

import type { PastSession, Turn } from './saved.ts';

/** How many matching sessions the excerpt draws from, most recent first. */
export const REVISIT_SESSION_CAP = 3;

/** How many turns are taken from each session, from its end. */
export const REVISIT_EXCERPT_TURNS = 4;

export type RevisitContext = {
	/** The sessions the excerpt was drawn from, most recent first. */
	sessions: PastSession[];
	/** The compiled excerpt, or `''` when nothing matched. */
	excerpt: string;
	/**
	 * Every matched turn's text joined together. Fed to
	 * {@link selectRevisitFocus} so the phrase focus is narrowed to phrases that
	 * actually occur in what is being revisited.
	 */
	transcript: string;
};

/** Case-insensitive contains, which is what the Latin half of a mixed turn needs. */
function mentions(turn: Turn, topic: string): boolean {
	return turn.text.toLowerCase().includes(topic.toLowerCase());
}

function renderTurns(turns: Turn[]): string {
	return turns
		.map((turn) => `${turn.role === 'user' ? 'Learner' : 'Tutor'}: ${turn.text}`)
		.join('\n');
}

/**
 * Find the sessions worth resuming and quote the tail of each.
 *
 * With a `topic`, a session matches when any of its turns mention it. Without
 * one, the most recent sessions are used, which is the plain "pick up where we
 * left off" case. Either way the result is capped and ordered most recent first,
 * so the freshest context leads.
 */
export function compileRevisitContext(
	sessions: PastSession[],
	{
		topic,
		sessionCap = REVISIT_SESSION_CAP,
		excerptTurns = REVISIT_EXCERPT_TURNS,
	}: { topic?: string; sessionCap?: number; excerptTurns?: number } = {},
): RevisitContext {
	const matching = sessions
		.filter(
			(session) =>
				topic === undefined ||
				session.turns.some((turn) => mentions(turn, topic)),
		)
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, Math.max(0, sessionCap));

	const excerpted = matching.map((session) => ({
		session,
		turns: session.turns.slice(-Math.max(0, excerptTurns)),
	}));

	return {
		sessions: matching,
		excerpt: excerpted
			.map(({ turns }) => renderTurns(turns))
			.filter((block) => block.length > 0)
			.join('\n\n'),
		transcript: excerpted
			.flatMap(({ turns }) => turns.map((turn) => turn.text))
			.join('\n'),
	};
}
