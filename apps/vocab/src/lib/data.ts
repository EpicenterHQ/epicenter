import type { AgentMessage } from '@epicenter/agent';
import { jsonValue } from '@epicenter/definition/field';
import {
	defineFolder,
	defineTable,
	type FileTable,
	type Folder,
	field,
	type RowReadError,
	rowPath,
	type StoredRow,
	type TableListing,
} from '@epicenter/folder';
import { Type } from 'typebox';
/**
 * Vocab's folder declaration and how its row files read. Isomorphic and inert:
 * importing it opens nothing.
 *
 * One local folder holds everything Vocab saves: the learner's words, each
 * chat's fixed focus, and every finished message. A saved thing is one
 * Markdown file. Nothing here has an account in it.
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

export const STAGES = ['new', 'recognized', 'understood', 'usable'] as const;
export type Stage = (typeof STAGES)[number];
/** What the learner reads for each stage. Only the learner sets one. */
export const STAGE_LABELS: Record<Stage, string> = {
	new: 'New',
	recognized: 'Recognize',
	understood: 'Understand',
	usable: 'Use',
};

/**
 * Learner-selected English expressions and their self-reported ability stage.
 * Notes and stages have one owner: the learner.
 */
const entriesTable = defineTable({
	fields: {
		text: field.string(),
		note: field.string(),
		stage: field.select(STAGES),
		createdAt: field.instant(),
	},
});

/** A chat is its creation time and the focus the learner chose for it. */
const chatsTable = defineTable({
	fields: {
		createdAt: field.instant(),
		focus: field.json(
			Type.Array(Type.Object({ entryId: Type.String(), text: Type.String() }), {
				minItems: 1,
				maxItems: 3,
			}),
		),
	},
});

/** One finished message, whole, and the stem of the chat it belongs to. */
const messagesTable = defineTable({
	fields: {
		chat: field.string(),
		message: field.json(
			Type.Object({
				id: Type.String(),
				role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
				createdAt: Type.Number(),
				parts: Type.Array(
					Type.Union([
						Type.Object({ type: Type.Literal('text'), text: Type.String() }),
						Type.Object({
							type: Type.Literal('tool-call'),
							toolCallId: Type.String(),
							toolName: Type.String(),
							input: jsonValue,
						}),
						Type.Object({
							type: Type.Literal('tool-result'),
							toolCallId: Type.String(),
							toolName: Type.String(),
							content: Type.String(),
							details: Type.Optional(jsonValue),
							isError: Type.Boolean(),
						}),
					]),
				),
			}),
		),
	},
});

export const vocabFolder = defineFolder({
	title: 'Vocab',
	kv: {},
	tables: {
		entries: entriesTable,
		chats: chatsTable,
		messages: messagesTable,
	},
});

export type VocabFolder = Folder<typeof vocabFolder>;
export type VocabTables = VocabFolder['tables'];

type FieldsOf<TTable> =
	TTable extends FileTable<infer TFields> ? TFields : never;
export type EntryFields = FieldsOf<VocabTables['entries']>;
type ChatFields = FieldsOf<VocabTables['chats']>;
type MessageFields = FieldsOf<VocabTables['messages']>;

/**
 * One saved word as the list last read it. `id` is the file stem; `stored`
 * is that read, the capture a stage press or a delete of a closed word is
 * guarded by.
 */
export type Entry = {
	id: string;
	text: string;
	note: string;
	stage: Stage;
	createdAt: string;
	stored: StoredRow<EntryFields>;
};

export type FocusItem = { entryId: string; text: string };
export type Chat = { id: string; createdAt: string; focus: FocusItem[] };
export type ChatMessage = { stem: string; chat: string; message: AgentMessage };

/**
 * The saved word a focus item's stage control acts on, if there is one. A
 * focus keeps the word's ID and its text, and a word's text never changes,
 * so a word at that ID with another text is a different word and is not it.
 */
export function focusWord(
	entries: readonly Entry[],
	item: FocusItem,
): Entry | undefined {
	return entries.find(
		(entry) => entry.id === item.entryId && entry.text === item.text,
	);
}

/**
 * A row file Vocab cannot show as a row, and why. It is never dropped
 * silently. `stem` is set when its text was read but is not a valid row, so
 * it can be repaired as text.
 */
export type UnreadableFile = { path: string; reason: string; stem?: string };

/** Why a row file could not be read as a row, in a sentence. */
export function rowProblem(error: RowReadError): string {
	return error.name === 'InvalidRow'
		? error.issues.map((issue) => issue.message).join(' ')
		: error.message;
}

export function readEntry(id: string, stored: StoredRow<EntryFields>): Entry {
	const { text, note, stage, createdAt } = stored.row.fields;
	return { id, text, note, stage, createdAt, stored };
}

export function readChat(id: string, stored: StoredRow<ChatFields>): Chat {
	const { createdAt, focus } = stored.row.fields;
	return {
		id,
		createdAt,
		focus: focus.map(({ entryId, text }) => ({ entryId, text })),
	};
}

export function readMessage(
	stem: string,
	stored: StoredRow<MessageFields>,
): ChatMessage {
	const { chat, message } = stored.row.fields;
	// The tutor loop owns a plain copy of the message.
	return { stem, chat, message: structuredClone(message) as AgentMessage };
}

/**
 * Split a table listing into the rows Vocab can show and the files it cannot.
 * A file that could not be read or is not a valid row is reported with its
 * path, never left out. A file removed after it was enumerated is gone.
 */
export function readRows<TFields, TRow>(
	table: string,
	listing: TableListing<TFields>,
	read: (stem: string, stored: StoredRow<TFields>) => TRow,
): { rows: TRow[]; unreadable: UnreadableFile[] } {
	const rows: TRow[] = [];
	const unreadable: UnreadableFile[] = [];
	for (const { stem, result } of listing) {
		if (result.error === null) rows.push(read(stem, result.data));
		else if (result.error.name !== 'NotFound')
			unreadable.push({
				path: rowPath(table, stem),
				reason: rowProblem(result.error),
				...(result.error.name === 'InvalidRow' ? { stem } : {}),
			});
	}
	return { rows, unreadable };
}
