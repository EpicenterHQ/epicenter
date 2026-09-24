import {
	defineStore,
	defineTable,
	field,
	jsonValue,
	plainText,
	type RowOf,
} from '@epicenter/app';
import type { DeclaredData } from '@epicenter/app/store';
import { APPS } from '@epicenter/constants/apps';
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
	body: plainText(),
});

/** One finished tutor message on this device, scoped to the signed-in account. */
const chatMessagesTable = defineTable({
	fields: {
		accountKey: field.string(),
		messageId: field.string(),
		message: field.json(jsonValue),
	},
});

/** Device-only current tutor exchange. No archive or presentation settings. */
export const chatHistoryDefinition = defineStore({
	id: APPS.VOCAB.id,
	title: 'Vocab chat on this device',
	kv: {},
	tables: {
		messages: chatMessagesTable,
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
