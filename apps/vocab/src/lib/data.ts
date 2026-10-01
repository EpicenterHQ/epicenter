import {
	defineStore,
	defineTable,
	field,
	jsonValue,
	type RowOf,
} from '@epicenter/app';
import type { DeclaredData } from '@epicenter/app/store';
import { APPS } from '@epicenter/constants/apps';
import { Type } from 'typebox';
/**
 * Vocab's inert local and personal store declarations. Isomorphic: no IndexedDB,
 * WebSockets, Svelte state, or browser APIs.
 *
 * The app imports it as `$lib/data`, which is the one specifier there is for
 * it. The declarations here are Vocab's storage contract.
 *
 * `AppBoot` captures the Account and opens both stores only after the primary
 * route mounts.
 */

import type { ServableModel } from '@epicenter/constants/ai-providers';

/**
 * The initial model for this device's tutor workflow. The learner may choose
 * another model through the inference picker; messages do not store that choice.
 */
export const VOCAB_MODEL = 'gemini-3.5-flash' satisfies ServableModel;

/**
 * The English vocabulary tutor's system prompt. Messages remain plain text
 * during streaming and render as Markdown when a response finishes.
 */
export const VOCAB_SYSTEM_PROMPT = `You are an English vocabulary tutor. Help the learner understand English words and phrases and use them naturally.

Guidelines:
- Explain meanings in clear English, with natural English examples.
- Show how meaning or tone changes with context when it matters.
- Answer follow-up questions and explain pronunciation when asked.
- Adjust difficulty from the learner's question rather than assuming a proficiency level.
- Do not claim to measure the learner's mastery or change saved entry stages.`;

/** Focus is model context, not a transcript message. */
export function tutorPrompt(
	focus: readonly { text: string }[],
	opening: boolean,
): string {
	return `${VOCAB_SYSTEM_PROMPT}\n\nThis chat focuses on these expressions: ${focus.map((item) => item.text).join(', ')}. ${opening ? 'Open the conversation yourself. Use them naturally and invite the learner to respond.' : 'Keep the focus in mind as you answer the learner.'} Do not ask for a definition quiz.`;
}

/**
 * Learner-selected English expressions and their self-reported ability stage.
 * Notes and stages have one owner: the learner.
 */
const entriesTable = defineTable({
	fields: {
		text: field.string(),
		note: field.string(),
		stage: field.select(['new', 'recognized', 'understood', 'usable']),
		// Validation-only rather than `string.date.parse`: a parsing form would hand
		// back a `Date` that could not round-trip through the projection.
		createdAt: field.instant(),
	},
});

/** One finished tutor message in an account's device-local conversation. */
const chatMessagesTable = defineTable({
	fields: {
		accountKey: field.string(),
		conversationId: field.string(),
		messageId: field.string(),
		message: field.json(jsonValue),
	},
});

const chatsTable = defineTable({
	fields: {
		accountKey: field.string(),
		createdAt: field.instant(),
		focus: field.json(
			Type.Array(Type.Object({ entryId: Type.String(), text: Type.String() }), {
				minItems: 1,
				maxItems: 3,
			}),
		),
	},
});

/** Device-local chats own chosen focus; messages own finished turns. */
export const chatHistoryDefinition = defineStore({
	id: APPS.VOCAB.id,
	title: 'Vocab chats on this device',
	kv: {},
	tables: {
		messages: chatMessagesTable,
		chats: chatsTable,
	},
});

/** Account-backed vocabulary entries follow the learner across devices. */
export const vocabDefinition = defineStore({
	id: APPS.VOCAB.id,
	title: 'Vocab',
	kv: {},
	tables: {
		entries: entriesTable,
	},
});

/** The typed view of Vocab's account-backed entries. */
export type VocabData = DeclaredData<typeof vocabDefinition>;

/** The typed view of this device's chat history. */
export type ChatHistoryData = DeclaredData<typeof chatHistoryDefinition>;

/** One entry row. Row ids are runtime-minted, so the runtime owns `id`. */
export type Entry = RowOf<typeof entriesTable>;
