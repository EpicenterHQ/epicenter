/**
 * The chat list and every chat write.
 *
 * The list is the `chats` table's rows, one query of the local folder
 * context, read on open and again when the folder reports a committed save
 * under `chats/`. Messages are named by their chat, so the list never reads
 * them; the open conversation reads its own.
 *
 * Starting a chat and saving each message enter Folder work before any await.
 * Normal folder close drains those admitted actions, including messages waiting
 * for their chat's turn: one at a time, in the order the loop made them.
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

export function createChats(local: VocabContext) {
	const { folder, queries, refresh } = local;
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
		async start(
			focus: readonly FocusItem[],
		): Promise<Result<Chat, ChatHistoryError>> {
			const admitted = await folder.run(async () => {
				const started = await startChat(folder.tables.chats, focus);
				if (started.error === null)
					await refresh([`chats/${started.data.id}.md`]);
				return started;
			});
			if (admitted.error !== null)
				return ChatHistoryError.NotSaved({ cause: admitted.error });
			return admitted.data;
		},
		/**
		 * How the open chat saves each message: in the chat's own turn, so its
		 * messages are written one at a time and in order. Each save is admitted
		 * before waiting its turn, so normal folder close drains queued writes.
		 */
		messageWriter(chatId: string): MessageWrite {
			return (_message, save) => {
				const previous = turns.get(chatId) ?? Promise.resolve();
				const saved = folder
					.run(async () => {
						await previous.catch(() => {});
						return save();
					})
					.then((admitted) =>
						admitted.error !== null
							? AgentMessageStoreError.WriteFailed({ cause: admitted.error })
							: admitted.data,
					);
				turns.set(chatId, saved);
				const release = () => {
					if (turns.get(chatId) === saved) turns.delete(chatId);
				};
				void saved.then(release, release);
				return saved;
			};
		},
	};
}

export type Chats = ReturnType<typeof createChats>;
