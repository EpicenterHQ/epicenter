import type { AgentMessage } from '@epicenter/agent';
import type { ServableModel } from '@epicenter/constants/ai-providers';
import type { NoteOf } from '@epicenter/definition/contract';
import type { Vocab } from './contract.js';

/**
 * What Vocab's notes mean to the app: the tutor's prompt, the stages, and
 * the shapes the views read. Isomorphic and inert: importing it opens
 * nothing. The files themselves are `contract.ts`'s.
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

/** A note of each of Vocab's collections, as read. */
export type EntryNote = NoteOf<Vocab['collections']['entries']>;
export type ChatNote = NoteOf<Vocab['collections']['chats']>;
export type MessageNote = NoteOf<Vocab['collections']['messages']>;

/**
 * One saved word. `id` is its file's name, the SHA-256 of `text`; `note` is
 * the note's body.
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

/** A note Vocab cannot show, and why, by its path. It is never dropped silently. */
export type UnreadableFile = { path: string; reason: string };

/** Why a note does not read, in one line. */
export const reasonOf = (issues: readonly { message: string }[]) =>
	issues.map(({ message }) => message).join(' ');

export function readEntry(note: EntryNote): Entry {
	const { id, text, body, stage, createdAt } = note;
	return { id, text, note: body, stage, createdAt };
}

export function readChat(note: ChatNote): Chat {
	const { id, createdAt, focus } = note;
	return {
		id,
		createdAt,
		focus: focus.map(({ entryId, text }) => ({ entryId, text })),
	};
}

/** A finished message as the tutor loop holds it: a plain copy, its own. */
export function readMessage(note: MessageNote): AgentMessage {
	const { id, role, createdAt, parts } = note;
	// SAFETY: the contract's parts are the agent's parts, as JSON.
	return structuredClone({ id, role, createdAt, parts }) as AgentMessage;
}
