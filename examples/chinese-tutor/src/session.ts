/**
 * Session openings: turn "which button did they press" into a seed.
 *
 * This is the only place the four surfaces differ. Each opening reads the same
 * two shared pools, decides what goes in play, composes one system prompt, and
 * optionally seeds one opening turn. It then hands back a `SessionSeed` that the
 * engine in `tutor.ts` runs without ever asking which surface produced it.
 *
 * Chat is the default and it is deliberately the emptiest case: base prompt, no
 * focus, no opening turn, an empty box. Everything else is that plus a paragraph
 * and a first line. If a surface ever needs more than a seed, the shared-engine
 * claim has failed and the seam is in the wrong place.
 */

import { selectPracticeFocus, selectRevisitFocus } from './focus.ts';
import {
	buildConversationBlock,
	buildPracticeBlock,
	buildRevisitBlock,
	composeSystemPrompt,
} from './prompt.ts';
import { compileRevisitContext } from './revisit.ts';
import type { PastSession, SavedPhrase, SessionIntentName } from './saved.ts';

/** What the user asked for by choosing an entry surface. */
export type SessionRequest =
	| { intent: 'chat' }
	| { intent: 'conversation' }
	| { intent: 'practice'; cap?: number }
	| { intent: 'revisit'; topic?: string; cap?: number };

/** The two shared pools, read by every opening. */
export type SessionSources = {
	phrases: SavedPhrase[];
	sessions: PastSession[];
};

/** Everything an opening decides. The engine consumes exactly this. */
export type SessionSeed = {
	intent: SessionIntentName;
	/** The composed prompt: tutor persona plus at most one session block. */
	systemPrompt: string;
	/**
	 * A first user turn to send automatically, or `null` for chat-first: the
	 * user types the first thing themselves.
	 *
	 * When present this is a plain, human-shaped line. It never lists the focus
	 * phrases, because it becomes a real persisted turn and therefore model
	 * memory for the rest of the session.
	 */
	opening: string | null;
	/** The phrases in play. Empty for chat and conversation, by construction. */
	focus: SavedPhrase[];
	/** For Revisit, the sessions the excerpt came from. Empty otherwise. */
	revisited: PastSession[];
};

const OPENINGS = {
	conversation: '我想随便聊聊。Let me just talk for a bit.',
	practice: '我想练习一下。Let me practice what I am working on.',
	resume: '我想接着上次的话题聊。Can we pick up where we left off?',
} as const;

/** Compile one entry surface into a seed. Pure: reads the pools, writes nothing. */
export function openSession(
	request: SessionRequest,
	{ phrases, sessions }: SessionSources,
): SessionSeed {
	switch (request.intent) {
		case 'chat':
			return {
				intent: 'chat',
				systemPrompt: composeSystemPrompt(null),
				opening: null,
				focus: [],
				revisited: [],
			};

		case 'conversation':
			// No focus is selected at all, so there is nothing for the tutor to
			// steer toward even if the block did not forbid it.
			return {
				intent: 'conversation',
				systemPrompt: composeSystemPrompt(buildConversationBlock()),
				opening: OPENINGS.conversation,
				focus: [],
				revisited: [],
			};

		case 'practice': {
			const focus = selectPracticeFocus(phrases, {
				...(request.cap !== undefined && { cap: request.cap }),
			});
			return {
				intent: 'practice',
				systemPrompt: composeSystemPrompt(buildPracticeBlock(focus)),
				opening: OPENINGS.practice,
				focus,
				revisited: [],
			};
		}

		case 'revisit': {
			const context = compileRevisitContext(sessions, {
				...(request.topic !== undefined && { topic: request.topic }),
			});
			const focus = selectRevisitFocus(phrases, {
				...(context.transcript.length > 0 && {
					transcript: context.transcript,
				}),
				...(request.cap !== undefined && { cap: request.cap }),
			});
			return {
				intent: 'revisit',
				systemPrompt: composeSystemPrompt(
					buildRevisitBlock({
						excerpt: context.excerpt,
						focus,
						...(request.topic !== undefined && { topic: request.topic }),
					}),
				),
				opening:
					request.topic === undefined
						? OPENINGS.resume
						: `我们上次聊过"${request.topic}"，我想再聊聊。Can we pick that back up?`,
				focus,
				revisited: context.sessions,
			};
		}

		default:
			request satisfies never;
			throw new Error('Unknown session intent');
	}
}
