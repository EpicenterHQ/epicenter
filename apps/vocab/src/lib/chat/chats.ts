/**
 * The chat list and every chat write.
 *
 * The list is the `chats` table's rows, one query of the local folder
 * context, read on open and again when the folder reports a committed save
 * under `chats/`. Messages are named by their chat, so the list never reads
 * them; the open conversation reads its own.
 *
 * Starting a chat and saving each message are Vocab's own actions, so
 * leaving the page waits while one runs. A chat's messages are saved in its
 * own turn: one at a time, in the order the loop made them.
 */

import { AgentMessageStoreError } from '@epicenter/agent';
import type { Result } from 'wellcrafted/result';
import {
	type Chat,
	type FocusItem,
	type RowOf,
	readChat,
	readRows,
	type UnreadableFile,
} from '../data.js';
import { CLOSING } from '../failure.js';
import type { VocabContext } from '../vocab.svelte.js';
import {
	byRecency,
	ChatHistoryError,
	type ChatSummary,
	type MessageWrite,
	startChat,
	summaryOf,
} from './messages.js';

/** The chat list, and the files in it that cannot be shown. */
export type ChatListing = {
	/** Every chat, newest first. */
	chats: ChatSummary[];
	/** Files in `chats/` that cannot be shown. */
	unreadable: UnreadableFile[];
};

/** The chat list as the `chats` table's rows read. */
export function listingOf(rows: readonly RowOf<'chats'>[]): ChatListing {
	const read = readRows('chats', rows, readChat);
	return {
		chats: read.rows.map(summaryOf).sort(byRecency),
		unreadable: read.unreadable,
	};
}

export function createChats({
	folder,
	queries,
	queryClient,
	edits,
	run,
}: VocabContext) {
	const rowsKey = queries.rows('chats').queryKey;
	/** The last message save of each chat, which the next one waits for. */
	const turns = new Map<string, Promise<unknown>>();

	return {
		/** The chat list, narrowed by `select` for one view. */
		chatsQuery<TData = ChatListing>(select?: (listing: ChatListing) => TData) {
			return {
				...queries.rows('chats'),
				select: (rows: RowOf<'chats'>[]): TData => {
					const listing = listingOf(rows);
					return select ? select(listing) : (listing as TData);
				},
			};
		},
		/**
		 * Save the focus as a new chat. It is in the list once the folder holds
		 * its file; the tutor opening is requested only after that.
		 */
		start(focus: readonly FocusItem[]): Promise<Result<Chat, ChatHistoryError>> {
			if (edits.fenced)
				return Promise.resolve(ChatHistoryError.NotSaved({ cause: CLOSING }));
			return run(async () => {
				const started = await startChat(folder.tables.chats, focus);
				if (started.error === null)
					await queryClient.invalidateQueries({ queryKey: rowsKey });
				return started;
			});
		},
		/**
		 * How the open chat saves each message: in the chat's own turn, so its
		 * messages are written one at a time and in order, and leaving the
		 * page waits for them.
		 */
		messageWriter(chatId: string): MessageWrite {
			return (_message, save) => {
				if (edits.fenced)
					return Promise.resolve(
						AgentMessageStoreError.WriteFailed({ cause: CLOSING }),
					);
				const previous = turns.get(chatId) ?? Promise.resolve();
				const saved = run(async () => {
					await previous.catch(() => {});
					return save();
				});
				turns.set(chatId, saved);
				void saved.finally(() => {
					if (turns.get(chatId) === saved) turns.delete(chatId);
				});
				return saved;
			};
		},
	};
}

export type Chats = ReturnType<typeof createChats>;
