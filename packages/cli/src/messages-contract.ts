/**
 * Messages' folder (`~/Epicenter/Messages` by default): one Markdown note
 * per outgoing reply, `replies/{id}.md`, that a person or an agent can read
 * and edit with any editor, offline.
 *
 * Front matter names the conversation (`chatId`, Beeper's id, and
 * `chatTitle` as it was when the reply was written, for a reader), the
 * Beeper accounts it was written against (`profile`, a sha256 of their
 * account ids), and whether it is still a `draft` or `ready` to send. The
 * body is the text. Neither status sends anything: a send names ready
 * replies by version (`messages-outbox.ts`), and a reply's note is removed
 * once Beeper confirms that exact text was sent.
 *
 * Conversations and their messages are Beeper's and are never kept here,
 * and neither is a send's progress, which the send journal holds
 * (`messages-journal.ts`).
 */
import { defineContract } from '@epicenter/definition/contract';

export const messagesContract = defineContract({
	name: 'messages',
	description:
		'Messages: a Markdown note per outgoing reply, a draft or ready to send through Beeper. Conversations stay in Beeper.',
	collections: {
		replies: {
			path: 'replies/{id}.md',
			fields: {
				chatId: { type: 'string' },
				chatTitle: { type: 'string' },
				profile: { type: 'string' },
				status: { enum: ['draft', 'ready'] },
			},
			required: ['chatId', 'profile', 'status'],
		},
	},
});

export type MessagesContract = typeof messagesContract;
