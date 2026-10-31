/**
 * Messages' contract: what it keeps on this device, as Markdown notes.
 *
 * - `drafts/{id}.md`: the reply being written in one conversation, in its
 *   body. Its front matter names the conversation (`chatId`), the Beeper
 *   accounts it was written against (`profile`), and whether that was the
 *   fictional demo or live Beeper (`mode`).
 * - `attempts/{id}.md`: the latest send from that composer: the text sent,
 *   in its body, whether Beeper has confirmed it (`state`), the attempt's
 *   own id, and Beeper's pending id once accepted.
 *
 * A draft and its attempt share an id, `<mode>-<sha256 of mode, profile and
 * chat>` (`draftId`), so demo and live drafts never share a file.
 * Conversations and their messages are Beeper's and are never kept here.
 * Messages has no settings, so it has no settings note.
 *
 * Published, unchanged, as `static/contract.json` (`bun run contract`), so
 * `epicenter check <url>/contract.json <dir>` checks a folder of them.
 */
import { defineContract } from '@epicenter/definition/contract';

const mode = { enum: ['demo', 'live'] } as const;

export const messages = defineContract({
	name: 'messages',
	description:
		'Messages: a Markdown note per conversation draft, and one for the latest send from it, kept on the device.',
	collections: {
		drafts: {
			path: 'drafts/{id}.md',
			fields: {
				chatId: { type: 'string' },
				profile: { type: 'string' },
				mode,
			},
			required: ['chatId', 'profile', 'mode'],
		},
		attempts: {
			path: 'attempts/{id}.md',
			fields: {
				chatId: { type: 'string' },
				profile: { type: 'string' },
				mode,
				state: { enum: ['sending', 'accepted', 'acknowledged'] },
				attemptId: { type: 'string' },
				pendingId: { type: 'string' },
			},
			required: [
				'chatId',
				'profile',
				'mode',
				'state',
				'attemptId',
				'pendingId',
			],
		},
	},
});

export type Messages = typeof messages;
