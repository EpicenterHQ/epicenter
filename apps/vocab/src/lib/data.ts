import type { AgentMessage } from '@epicenter/agent';
import type { ServableModel } from '@epicenter/constants/ai-providers';
import type { Row } from '@epicenter/folder/next';
import type { SvelteFolder } from '@epicenter/svelte/folder-next';
import { Type } from 'typebox';

/**
 * Vocab's tables and how its rows read. Isomorphic and inert: importing it
 * opens nothing.
 *
 * This browser's local folder, `openFolder({ tables: vocabTables })`, holds
 * everything Vocab saves: the learner's words, each chat's fixed focus, and
 * every finished message. A saved thing is one Markdown file. Nothing here
 * has an account in it.
 */

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

const focusItem = Type.Object({ entryId: Type.String(), text: Type.String() });

/**
 * The tables Vocab reads, each a top-level directory of Markdown rows with
 * its fields in frontmatter. A schema only interprets: a save keeps fields it
 * does not name, and a file that does not fit is listed with its source and
 * issues.
 *
 * - `entries/<SHA-256 of the text>.md`: one learner-selected expression, the
 *   learner's note, and the self-reported stage. Only the learner sets the
 *   note and the stage.
 * - `chats/<id>.md`: when the chat started and the focus chosen for it.
 * - `messages/<chat id>.<message id>.md`: one finished message, whole, and
 *   the ID of its chat.
 */
export const vocabTables = {
	entries: Type.Object({
		text: Type.String(),
		note: Type.String(),
		stage: Type.Union([
			Type.Literal('new'),
			Type.Literal('recognized'),
			Type.Literal('understood'),
			Type.Literal('usable'),
		]),
		createdAt: Type.String(),
	}),
	chats: Type.Object({
		createdAt: Type.String(),
		focus: Type.Array(focusItem, { minItems: 1, maxItems: 3 }),
	}),
	messages: Type.Object({
		chat: Type.String(),
		message: Type.Object({
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
						input: Type.Unknown(),
					}),
					Type.Object({
						type: Type.Literal('tool-result'),
						toolCallId: Type.String(),
						toolName: Type.String(),
						content: Type.String(),
						details: Type.Optional(Type.Unknown()),
						isError: Type.Boolean(),
					}),
				]),
			),
		}),
	}),
};

export type VocabTables = typeof vocabTables;
export type VocabFolder = SvelteFolder<VocabTables>;

/** A row of `table`, as it reads: its source, its fields, and any issues. */
export type RowOf<TName extends keyof VocabTables> = Row<VocabTables[TName]>;
/** A row of `table` that reads as one: its fields fit the schema. */
export type ValidRowOf<TName extends keyof VocabTables> = Extract<
	RowOf<TName>,
	{ issues: null }
>;

/** The file of row `id` of `table`. */
export const rowPath = (table: keyof VocabTables, id: string) =>
	`${table}/${id}.md`;

/**
 * One saved word from the mirror. `id` is the file's name.
 */
export type Entry = {
	id: string;
	text: string;
	note: string;
	stage: Stage;
	createdAt: string;
};

export type FocusItem = { entryId: string; text: string };
export type Chat = { id: string; createdAt: string; focus: FocusItem[] };
export type ChatMessage = { id: string; chat: string; message: AgentMessage };

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
 * silently. `id` is set when the file is text, so it can be repaired as text.
 */
export type UnreadableFile = { path: string; reason: string; id?: string };
type ReadRows<TRow> = { rows: TRow[]; unreadable: UnreadableFile[] };

export function readEntry(row: ValidRowOf<'entries'>): Entry {
	const { text, note, stage, createdAt } = row.fields;
	return { id: row.id, text, note, stage, createdAt };
}

export function readChat(row: ValidRowOf<'chats'>): Chat {
	const { createdAt, focus } = row.fields;
	return {
		id: row.id,
		createdAt,
		focus: focus.map(({ entryId, text }) => ({ entryId, text })),
	};
}

export function readMessage(row: ValidRowOf<'messages'>): ChatMessage {
	const { chat, message } = row.fields;
	// The tutor loop owns a plain copy of the message.
	return {
		id: row.id,
		chat,
		// SAFETY: cloning a schema-validated message preserves its shape.
		message: structuredClone(message) as AgentMessage,
	};
}

/**
 * Split a table's rows into the ones Vocab can show and the files it cannot,
 * each named by its path with why. A non-text or unreadable file has no `id`:
 * it is only named, never repaired here.
 */
export function readRows<TName extends keyof VocabTables, TRow>(
	table: TName,
	rows: readonly RowOf<TName>[],
	read: (row: ValidRowOf<TName>) => TRow,
): ReadRows<TRow> {
	const readable: TRow[] = [];
	const unreadable: UnreadableFile[] = [];
	for (const row of rows) {
		if (row.issues === null) {
			// SAFETY: the valid branch has fields of the table's schema.
			readable.push(read(row as ValidRowOf<TName>));
			continue;
		}
		const text = !row.issues.some(
			(issue) => issue.kind === 'not-text' || issue.kind === 'unreadable',
		);
		unreadable.push({
			path: row.path,
			reason: row.issues.map((issue) => issue.message).join(' '),
			...(text ? { id: row.id } : {}),
		});
	}
	return { rows: readable, unreadable };
}
