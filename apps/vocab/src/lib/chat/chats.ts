/**
 * The chat list and every chat write, kept in the TanStack Query cache
 * (ADR-0528).
 *
 * The list is one query over the folder's `chats` table and the message
 * files an earlier version saved. Messages saved now are named by their
 * chat, so the list never reads them; the open conversation reads its own.
 * The list is keyed under the `chats` table's listing, so it is read on open
 * and again when the folder reports a change to `chats/`. A chat this page
 * starts is put in the list by the start itself.
 *
 * Starting a chat and saving each message are mutations. A message's save is
 * scoped to its chat's file, so one chat's messages are written in order,
 * and closing waits for every one under way.
 */

import { AgentMessageStoreError, agentMessageText } from '@epicenter/agent';
import { type FileError, rowPath } from '@epicenter/folder';
import type { QueryClient } from '@tanstack/svelte-query';
import { createQueryFactories, resultQueryOptions } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type FocusItem,
	readChat,
	readRows,
	type UnreadableFile,
	type VocabFolder,
} from '../data.js';
import { type VocabOptions, vocabKeys, type WriteFailure } from '../query.js';
import {
	byRecency,
	ChatHistoryError,
	type ChatSummary,
	isEarlierMessage,
	listChats,
	listMessageStems,
	type MessageWrite,
	messageStem,
	readMessages,
	startChat,
	summaryOf,
} from './messages.js';

/** The chat list, and the files in it that cannot be shown. */
export type ChatListing = {
	/** Every chat, newest first. */
	chats: ChatSummary[];
	/** Files in `chats/`, and earlier files in `messages/`, that cannot be shown. */
	unreadable: UnreadableFile[];
};

export function createChats(
	{ tables, files }: Pick<VocabFolder, 'tables' | 'files'>,
	folder$: Pick<VocabOptions, 'chats'>,
	queryClient: QueryClient,
	{
		refused,
		onWriteFailed,
	}: {
		/** Why no change starts now, if one does not. */
		refused: () => string | undefined;
		/** A message write failed; the app tells the learner and offers its text. */
		onWriteFailed: (failure: WriteFailure) => void;
	},
) {
	const { defineMutation } = createQueryFactories(queryClient);
	/** Under the `chats` listing's key, so a change to `chats/` reaches it. */
	const listKey = [...folder$.chats.list.queryKey(), 'summaries'];

	async function readChats(): Promise<Result<ChatListing, FileError>> {
		const [
			{ data: chatListing, error: chatError },
			{ data: stems, error: stemError },
		] = await Promise.all([tables.chats.list(), listMessageStems(files)]);
		if (chatError !== null) return Err(chatError);
		if (stemError !== null) return Err(stemError);
		const messages = await readMessages(
			tables.messages,
			stems.filter(isEarlierMessage),
		);
		const read = readRows(tables.chats.name, chatListing, readChat);
		return Ok({
			chats: listChats(read.rows, messages.rows),
			unreadable: [...read.unreadable, ...messages.unreadable],
		});
	}

	return {
		/** The chat list, narrowed by `select` for one view. */
		chatsQuery<TData = ChatListing>(select?: (listing: ChatListing) => TData) {
			return resultQueryOptions({
				queryKey: listKey,
				queryFn: readChats,
				select,
			});
		},
		/**
		 * Save the focus as a new chat. It is in the list once the folder holds
		 * its file; the tutor opening is requested only after that.
		 */
		start: defineMutation({
			mutationKey: vocabKeys.startChat,
			mutationFn: async (focus: readonly FocusItem[]) => {
				const why = refused();
				if (why !== undefined) return ChatHistoryError.NotSaved({ cause: why });
				return startChat(tables.chats, focus);
			},
			onSuccess: (chat) => {
				// A read still running may not hold it: read once more instead.
				if (queryClient.isFetching({ queryKey: listKey, exact: true }) > 0)
					return queryClient.invalidateQueries({
						queryKey: listKey,
						exact: true,
					});
				queryClient.setQueryData<ChatListing>(listKey, (listing) =>
					listing === undefined
						? undefined
						: {
								...listing,
								chats: [
									...listing.chats.filter(({ id }) => id !== chat.id),
									summaryOf(chat),
								].sort(byRecency),
							},
				);
			},
		}),
		/**
		 * How the open chat saves each message: a mutation scoped to the chat's
		 * file, so its messages are written one at a time and in order, and
		 * closing waits for them. A failed save is reported with its text.
		 */
		messageWriter(chatId: string): MessageWrite {
			return async (message, save) => {
				const why = refused();
				if (why !== undefined)
					return AgentMessageStoreError.WriteFailed({ cause: why });
				return defineMutation({
					mutationKey: vocabKeys.message(chatId),
					scope: { id: rowPath(tables.chats.name, chatId) },
					mutationFn: save,
					onError: (error) =>
						onWriteFailed({
							path: rowPath(
								tables.messages.name,
								messageStem(chatId, message.id),
							),
							error,
							lost: agentMessageText(message),
						}),
				})();
			};
		},
	};
}

export type Chats = ReturnType<typeof createChats>;
