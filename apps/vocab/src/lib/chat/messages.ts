import {
	type AgentMessage,
	type AgentMessageStore,
	AgentMessageStoreError,
	agentMessageText,
} from '@epicenter/agent';
import { InstantString } from '@epicenter/definition/field';
import {
	type FileError,
	type FolderFiles,
	rowPath,
	rowStemOf,
} from '@epicenter/folder';
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
	rowProblem,
	type UnreadableFile,
	type VocabFolder,
	type VocabTables,
} from '../data.js';

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

/** A message's file stem: its chat's ID, a dot, and the message ID. */
export const messageStem = (chatId: string, messageId: string) =>
	`${chatId}.${messageId}`;

/**
 * Whether a message stem predates chat prefixes. An earlier version named a
 * message file by its message ID alone, which has no dot.
 */
export const isEarlierMessage = (stem: string) => !stem.includes('.');

/** The stems of every row file in `messages/`, read from the directory alone. */
export async function listMessageStems(
	files: FolderFiles,
): Promise<Result<string[], FileError>> {
	const { data: children, error } = await files.children('messages');
	if (error?.name === 'NotFound') return Ok([]);
	if (error !== null) return Err(error);
	return Ok(
		children.files.flatMap((name) => {
			const stem = rowStemOf('messages', `messages/${name}`);
			return stem === undefined ? [] : [stem];
		}),
	);
}

/** Read the messages at `stems`, and report the files that are not valid messages. */
export async function readMessages(
	table: VocabTables['messages'],
	stems: readonly string[],
): Promise<{ rows: ChatMessage[]; unreadable: UnreadableFile[] }> {
	const reads = await Promise.all(stems.map((stem) => table.get(stem)));
	const rows: ChatMessage[] = [];
	const unreadable: UnreadableFile[] = [];
	reads.forEach(({ data: stored, error }, index) => {
		const stem = stems[index] ?? '';
		if (error !== null)
			unreadable.push({
				path: rowPath(table.name, stem),
				reason: rowProblem(error),
			});
		else if (stored !== undefined) rows.push(readMessage(stem, stored));
	});
	return { rows, unreadable };
}

/**
 * How one message's save runs: by default at once; in the app, as a
 * mutation scoped to its chat, so a chat's messages are written in order and
 * closing waits for them.
 */
export type MessageWrite = (
	message: AgentMessage,
	save: () => Promise<Result<undefined, AgentMessageStoreError>>,
) => Promise<Result<undefined, AgentMessageStoreError>>;

/**
 * One chat's finished messages, presented to the tutor loop.
 *
 * A message's file is `messages/<chat ID>.<message ID>.md`, so a chat reads
 * only its own files, found by name, plus the files an earlier version
 * named by message ID alone. `entries` is the latest read together with every
 * message this store saved: a read never hides a message saved here. `set`
 * resolves `Ok` only once the folder holds the file, so the loop asks the
 * tutor nothing before a learner message is a file.
 *
 * A create merges into a file already at its stem, so a save reads the
 * stem first and creates only when no file is there. Saving a message again
 * after an answer that never arrived finds its own file, compares it, and
 * adds no second one; a different message at that name is refused.
 */
export function createChatMessageStore(
	{ tables, files }: Pick<VocabFolder, 'tables' | 'files'>,
	chatId: string,
	/** Runs each message's save; the app makes it a mutation. */
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
	const prefix = messageStem(chatId, '');
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
		const stem = messageStem(chatId, key);
		// A create merges into a file already at its stem, so the stem is read
		// first. An earlier attempt may have landed without its answer.
		const { data: current, error: readError } = await table.get(stem);
		if (
			readError !== null &&
			readError.name !== 'InvalidRow' &&
			readError.name !== 'InvalidUtf8'
		)
			return AgentMessageStoreError.WriteFailed({ cause: readError });
		if (readError !== null || current !== undefined) {
			if (
				current?.row.fields.chat !== chatId ||
				!sameJson(current.row.fields.message, value)
			) {
				const { error: taken } = ChatHistoryError.Taken({
					path: rowPath(table.name, stem),
				});
				return AgentMessageStoreError.WriteFailed({ cause: taken });
			}
		} else {
			const { error: createError } = await table.create(
				{ fields: { chat: chatId, message: value }, body: '' },
				{ stem },
			);
			if (createError !== null)
				return AgentMessageStoreError.WriteFailed({ cause: createError });
		}
		created.set(key, value);
		notify();
		return Ok(undefined);
	}

	return {
		get unreadable() {
			return unreadable;
		},
		async load() {
			const mine = ++loads;
			const { data: stems, error: listError } = await listMessageStems(files);
			if (listError !== null)
				return ChatHistoryError.NotRead({ cause: listError });
			const read = await readMessages(
				table,
				stems.filter(
					(stem) => stem.startsWith(prefix) || isEarlierMessage(stem),
				),
			);
			// A later load was asked for; its read is the one to show.
			if (mine !== loads) return Ok(undefined);
			const next = new Map<string, ChatMessage>();
			for (const row of read.rows) {
				if (row.chat !== chatId) continue;
				// Two files can hold one message id; the lowest stem is shown.
				const previous = next.get(row.message.id);
				if (!previous || row.stem < previous.stem)
					next.set(row.message.id, row);
			}
			listed = new Map([...next].map(([id, row]) => [id, row.message]));
			// An earlier file that cannot be read names no chat; the chat list reports it.
			unreadable = read.unreadable.filter(({ path }) =>
				path.startsWith(`messages/${prefix}`),
			);
			notify();
			return Ok(undefined);
		},
		set: (key, value) => write(value, () => save(key, value)),
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
 * Save the learner's focus as a new chat and answer with its ID once the
 * folder holds the file. The tutor opening is requested only after that.
 */
export async function startChat(
	chats: VocabTables['chats'],
	focus: readonly FocusItem[],
): Promise<Result<Chat, ChatHistoryError>> {
	if (
		focus.length < 1 ||
		focus.length > 3 ||
		focus.some((item) => !item.entryId || !item.text.trim())
	)
		return ChatHistoryError.InvalidFocus();
	const chat = {
		createdAt: InstantString.now(),
		focus: focus.map(({ entryId, text }) => ({ entryId, text })),
	};
	const { data: created, error: createError } = await chats.create({
		fields: chat,
		body: '',
	});
	if (createError !== null)
		return ChatHistoryError.NotSaved({ cause: createError });
	if (created === null)
		return ChatHistoryError.NotSaved({
			cause: 'The new file does not read as a chat',
		});
	return Ok({ id: rowStemOf(chats.name, created.path) ?? '', ...chat });
}

/** One chat as the chat list shows it. */
export type ChatSummary = {
	id: string;
	title: string;
	focus: FocusItem[];
	updatedAt: number;
	legacy: boolean;
};

/** A `chats` row as the chat list shows it: titled by its focus, placed by when it started. */
export function summaryOf(chat: Chat): ChatSummary {
	return {
		id: chat.id,
		title: chat.focus.map((item) => item.text).join(', '),
		focus: chat.focus,
		updatedAt: Date.parse(chat.createdAt),
		legacy: false,
	};
}

/** Newest first, then by ID. */
export const byRecency = (a: ChatSummary, b: ChatSummary) =>
	b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/**
 * Every chat, newest first. A chat is a `chats` row, placed by when it
 * started. `messages` are the files an earlier version saved, named by message
 * ID alone: they move their chat up to their latest time, and those whose
 * chat has no row are an earlier, message-only chat, shown with its first
 * learner question as the title and no focus invented for it.
 */
export function listChats(
	chats: readonly Chat[],
	messages: readonly ChatMessage[],
) {
	const summaries = new Map<string, ChatSummary>();
	const firstQuestion = new Map<string, { time: number; stem: string }>();
	for (const row of chats) summaries.set(row.id, summaryOf(row));
	for (const { stem, chat: chatId, message } of messages) {
		let chat = summaries.get(chatId);
		if (!chat) {
			chat = {
				id: chatId,
				title: 'Earlier chat',
				focus: [],
				updatedAt: 0,
				legacy: true,
			};
			summaries.set(chatId, chat);
		}
		chat.updatedAt = Math.max(chat.updatedAt, message.createdAt);
		const previous = firstQuestion.get(chat.id);
		if (
			chat.legacy &&
			message.role === 'user' &&
			(!previous ||
				message.createdAt < previous.time ||
				(message.createdAt === previous.time && stem < previous.stem))
		) {
			firstQuestion.set(chat.id, { time: message.createdAt, stem });
			chat.title =
				agentMessageText(message).trim().slice(0, 60) || 'Earlier chat';
		}
	}
	return [...summaries.values()].sort(byRecency);
}
