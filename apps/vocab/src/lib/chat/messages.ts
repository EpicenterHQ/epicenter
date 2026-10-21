import {
	type AgentMessage,
	type AgentMessageStore,
	AgentMessageStoreError,
} from '@epicenter/agent';
import type { ReadError } from '@epicenter/folder';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type Chat,
	type ChatMessage,
	type FocusItem,
	readMessage,
	readRows,
	rowPath,
	type UnreadableFile,
	type VocabFolder,
} from '../data.js';
import { untilClosed } from '../failure.js';

export const ChatHistoryError = defineErrors({
	/** The folder could not list the messages, so the transcript is unknown. */
	NotRead: ({ cause }: { cause: unknown }) => ({
		message: `This chat could not be read: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The folder did not confirm the new chat's file. */
	NotSaved: ({ cause }: { cause: unknown }) => ({
		message: `This chat was not saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
	InvalidFocus: () => ({ message: 'Choose one to three saved expressions.' }),
	/** A different message already has this file. Nothing was written. */
	Taken: ({ path }: { path: string }) => ({
		message: `Another message is already saved at '${path}'.`,
		path,
	}),
});
export type ChatHistoryError = InferErrors<typeof ChatHistoryError>;

/**
 * Whether two JSON values are equal. A file keeps neither key order nor a key
 * whose value is `undefined`, so neither counts.
 */
function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const keys = (value: object) =>
		Object.keys(value).filter(
			(key) => (value as Record<string, unknown>)[key] !== undefined,
		);
	const [left, right] = [keys(a), keys(b)];
	return (
		left.length === right.length &&
		left.every((key) =>
			sameJson(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
			),
		)
	);
}

/** A message's row ID: its chat's ID, a dot, and the message ID. */
export const messageId = (chatId: string, id: string) => `${chatId}.${id}`;

/**
 * The row IDs of one chat's message files, read from their names alone:
 * `messages/<chat id>.<message id>.md`.
 */
async function listMessageIds(
	files: VocabFolder['files'],
	chatId: string,
): Promise<Result<string[], ReadError>> {
	const prefix = `messages/${messageId(chatId, '')}`;
	const { data: paths, error } = await files.list(prefix);
	if (error !== null) return Err(error);
	return Ok(
		paths.flatMap((path) => {
			const id = path.slice('messages/'.length, -'.md'.length);
			return path.endsWith('.md') && !id.includes('/') ? [id] : [];
		}),
	);
}

/** Read the messages at `ids`, and report the files that are not valid messages. */
async function readMessages(
	table: VocabFolder['tables']['messages'],
	ids: readonly string[],
): Promise<
	Result<{ rows: ChatMessage[]; unreadable: UnreadableFile[] }, ReadError>
> {
	const reads = await Promise.all(ids.map((id) => table.get(id)));
	const rows = [];
	for (const { data, error } of reads) {
		if (error !== null) return Err(error);
		// Deleted since it was listed: it is gone.
		if (data !== undefined) rows.push(data);
	}
	return Ok(readRows('messages', rows, readMessage));
}

/**
 * How one message's save runs: by default at once; in the app, admitted as
 * folder work and run in its chat's turn, so normal folder close drains each
 * accepted save.
 */
export type MessageWrite = (
	message: AgentMessage,
	save: () => Promise<Result<undefined, AgentMessageStoreError>>,
) => Promise<Result<undefined, AgentMessageStoreError>>;

/**
 * One chat's finished messages, presented to the tutor loop.
 *
 * A message's file is `messages/<chat ID>.<message ID>.md`, so a chat reads
 * only its own files, found by name. `entries` is the latest read together
 * with every message this store saved: a read never hides a message saved
 * here. `set` resolves `Ok` only once the folder holds the file, so the loop
 * asks the tutor nothing before a learner message is a file.
 *
 * A save reads the message's file first and writes only when none is there.
 * Saving a message again after an answer that never arrived finds its own
 * file, compares it, and adds no second one; a different message at that
 * name is refused.
 */
export function createChatMessageStore(
	{ tables, files }: Pick<VocabFolder, 'tables' | 'files'>,
	chatId: string,
	/** Runs each message's save; the app runs it in the chat's turn. */
	write: MessageWrite = (_message, save) => save(),
): AgentMessageStore & {
	/** Message files of this chat that cannot be shown or sent to the tutor. */
	readonly unreadable: UnreadableFile[];
	/**
	 * Read this chat's messages from the folder. Until the first read
	 * answers, the store holds only what it saved; a failed read leaves what
	 * it had.
	 */
	load(): Promise<Result<void, ChatHistoryError>>;
} {
	const table = tables.messages;
	let listed = new Map<string, AgentMessage>();
	/** Messages this store saved, kept over any read. */
	const created = new Map<string, AgentMessage>();
	let unreadable: UnreadableFile[] = [];
	let loads = 0;
	const handlers = new Set<() => void>();
	const notify = () => {
		for (const handler of handlers) handler();
	};

	async function save(
		key: string,
		value: AgentMessage,
	): Promise<Result<undefined, AgentMessageStoreError>> {
		const id = messageId(chatId, key);
		// A file keeps JSON: a key whose value is `undefined` is not written.
		const message = JSON.parse(JSON.stringify(value)) as AgentMessage;
		const { data: current, error: readError } = await tables.messages.get(id);
		if (readError !== null)
			return AgentMessageStoreError.WriteFailed({ cause: readError });
		if (current !== undefined) {
			// An earlier attempt may have landed without its answer: it is this
			// message only if it holds it.
			if (
				current.issues !== null ||
				current.fields.chat !== chatId ||
				!sameJson(current.fields.message, message)
			) {
				const { error: taken } = ChatHistoryError.Taken({
					path: rowPath('messages', id),
				});
				return AgentMessageStoreError.WriteFailed({ cause: taken });
			}
		} else {
			const { error } = await tables.messages.set(id, null, {
				fields: { chat: chatId, message },
				body: '',
			});
			if (error !== null)
				return AgentMessageStoreError.WriteFailed({ cause: error });
		}
		created.set(key, value);
		notify();
		return Ok(undefined);
	}

	async function read() {
		const { data: ids, error } = await listMessageIds(files, chatId);
		if (error !== null) return Err(error);
		return readMessages(table, ids);
	}

	return {
		get unreadable() {
			return unreadable;
		},
		async load() {
			const mine = ++loads;
			const { data: listing, error } = await untilClosed(read, (cause) =>
				ChatHistoryError.NotRead({ cause }),
			);
			if (error !== null)
				return error.name === 'NotRead'
					? Err(error)
					: ChatHistoryError.NotRead({ cause: error });
			// A later load was asked for; its read is the one to show.
			if (mine !== loads) return Ok(undefined);
			const next = new Map<string, ChatMessage>();
			for (const row of listing.rows) {
				if (row.chat !== chatId) continue;
				// Two files can hold one message id; the lowest file name is shown.
				const previous = next.get(row.message.id);
				if (!previous || row.id < previous.id) next.set(row.message.id, row);
			}
			listed = new Map([...next].map(([id, row]) => [id, row.message]));
			unreadable = listing.unreadable;
			notify();
			return Ok(undefined);
		},
		set: (key, value) =>
			write(value, () =>
				untilClosed(
					() => save(key, value),
					(cause) => AgentMessageStoreError.WriteFailed({ cause }),
				),
			),
		*entries() {
			for (const [key, val] of listed)
				if (!created.has(key)) yield { key, val };
			for (const [key, val] of created) yield { key, val };
		},
		observe(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		[Symbol.dispose]() {
			handlers.clear();
		},
	};
}

/**
 * Save the learner's focus as a new chat and answer with it once the folder
 * holds its file. The tutor opening is requested only after that.
 */
export async function startChat(
	chats: VocabFolder['tables']['chats'],
	focus: readonly FocusItem[],
): Promise<Result<Chat, ChatHistoryError>> {
	if (
		focus.length < 1 ||
		focus.length > 3 ||
		focus.some((item) => !item.entryId || !item.text.trim())
	)
		return ChatHistoryError.InvalidFocus();
	const chat = {
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		focus: focus.map(({ entryId, text }) => ({ entryId, text })),
	};
	const { error } = await untilClosed(
		() =>
			chats.set(chat.id, null, {
				fields: { createdAt: chat.createdAt, focus: chat.focus },
				body: '',
			}),
		(cause) => Err(cause),
	);
	if (error !== null) return ChatHistoryError.NotSaved({ cause: error });
	return Ok(chat);
}

/** One chat as the chat list shows it. */
export type ChatSummary = {
	id: string;
	title: string;
	focus: FocusItem[];
	updatedAt: number;
};

/** A `chats` row as the chat list shows it: titled by its focus, placed by when it started. */
export function summaryOf(chat: Chat): ChatSummary {
	return {
		id: chat.id,
		title: chat.focus.map((item) => item.text).join(', '),
		focus: chat.focus,
		updatedAt: Date.parse(chat.createdAt),
	};
}

/** Newest first, then by ID. */
export const byRecency = (a: ChatSummary, b: ChatSummary) =>
	b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
