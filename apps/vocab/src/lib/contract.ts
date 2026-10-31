/**
 * Vocab's contract: a learner's words and tutor chats, as Markdown notes.
 *
 * - `entries/{id}.md`: one saved expression. `text` is the exact expression
 *   (`id` is the SHA-256 of it), `stage` how well the learner says they know
 *   it (only the learner sets it), `createdAt` when it was saved; the
 *   learner's own note is the body.
 * - `chats/{id}.md`: one tutor chat: when it started, and its focus, the one
 *   to three saved expressions it practices (each the word's id and text).
 * - `messages/{chat}/{id}.md`: one finished message of chat `chat`, whole:
 *   who wrote it, when (milliseconds), and its parts (text, and the tutor's
 *   tool calls and their results).
 *
 * Vocab's settings (the tutor model chosen and the endpoints connected) are
 * this device's, not the learner's data, so there is no settings note.
 * Its name makes the repository `<account>/vocab`. Published, unchanged, as
 * `static/contract.json` (`bun run contract`), so `epicenter check
 * <url>/contract.json <dir>` checks a clone.
 */
import { defineContract } from '@epicenter/definition/contract';

const text = { type: 'string' } as const;

export const vocab = defineContract({
	name: 'vocab',
	description:
		'Vocab: a Markdown note per saved expression (the learner’s note in its body), per tutor chat, and per finished chat message.',
	collections: {
		entries: {
			path: 'entries/{id}.md',
			fields: {
				text,
				stage: { enum: ['new', 'recognized', 'understood', 'usable'] },
				createdAt: text,
			},
			required: ['text', 'stage', 'createdAt'],
		},
		chats: {
			path: 'chats/{id}.md',
			fields: {
				createdAt: text,
				focus: {
					type: 'array',
					minItems: 1,
					maxItems: 3,
					items: {
						type: 'object',
						properties: { entryId: text, text },
						required: ['entryId', 'text'],
					},
				},
			},
			required: ['createdAt', 'focus'],
		},
		messages: {
			path: 'messages/{chat}/{id}.md',
			fields: {
				role: { enum: ['user', 'assistant'] },
				createdAt: { type: 'number' },
				parts: {
					type: 'array',
					items: {
						anyOf: [
							{
								type: 'object',
								properties: { type: { const: 'text' }, text },
								required: ['type', 'text'],
							},
							{
								type: 'object',
								properties: {
									type: { const: 'tool-call' },
									toolCallId: text,
									toolName: text,
									input: {},
								},
								required: ['type', 'toolCallId', 'toolName', 'input'],
							},
							{
								type: 'object',
								properties: {
									type: { const: 'tool-result' },
									toolCallId: text,
									toolName: text,
									content: text,
									details: {},
									isError: { type: 'boolean' },
								},
								required: [
									'type',
									'toolCallId',
									'toolName',
									'content',
									'isError',
								],
							},
						],
					},
				},
			},
			required: ['role', 'createdAt', 'parts'],
		},
	},
});

export type Vocab = typeof vocab;
