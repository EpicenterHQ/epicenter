/**
 * The chat list and every chat write, kept in the TanStack Query cache
 * (ADR-0528).
 *
 * The list is one query over the folder's `chats` table (`queries.query`),
 * read on open and again when a change reaches `chats/`. Messages are named
 * by their chat, so the list never reads them; the open conversation reads
 * its own. A chat this page starts is put in the list by the start itself.
 *
 * Starting a chat and saving each message are mutations. A message's save is
 * scoped to its chat's file, so one chat's messages are written in order,
 * and closing waits for every one under way.
 */

import { AgentMessageStoreError, agentMessageText } from '@epicenter/agent';
import { type FileError, rowPath } from '@epicenter/folder';
import type { WriteFailure } from '@epicenter/svelte/write-failure';
import type { QueryClient } from '@tanstack/svelte-query';
import { createQueryFactories } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type FocusItem,
	readChat,
	readRows,
	type UnreadableFile,
	type VocabFolder,
} from '../data.js';
import { type VocabOptions, vocabKeys } from '../query.js';
import {
	byRecency,
	ChatHistoryError,
	type ChatSummary,
	type MessageWrite,
	messageStem,
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

export function createChats(
	{ tables }: Pick<VocabFolder, 'tables'>,
	queries: Pick<VocabOptions, 'query'>,
	queryClient: QueryClient,
	{
		refused,
		writeFailed,
	}: {
		/** Why no change starts now, if one does not. */
		refused: () => string | undefined;
		/** A message write failed; the app tells the learner and offers its text. */
		writeFailed: (failure: WriteFailure) => void;
	},
) {
	const { defineMutation } = createQueryFactories(queryClient);

	async function readChats(): Promise<Result<ChatListing, FileError>> {
		const { data: chatListing, error } = await tables.chats.list();
		if (error !== null) return Err(error);
		const read = readRows(tables.chats.name, chatListing, readChat);
		return Ok({
			chats: read.rows.map(summaryOf).sort(byRecency),
			unreadable: read.unreadable,
		});
	}

	const listing = queries.query({
		paths: [tables.chats.name],
		key: ['summaries'],
		queryFn: readChats,
	});
	const listKey = listing.queryKey;

	return {
		/** The chat list, narrowed by `select` for one view. */
		chatsQuery<TData = ChatListing>(select?: (listing: ChatListing) => TData) {
			return { ...listing, select };
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
						writeFailed({
							path: rowPath(
								tables.messages.name,
								messageStem(chatId, message.id),
							),
							error,
							unsaved: agentMessageText(message),
						}),
				})();
			};
		},
	};
}

export type Chats = ReturnType<typeof createChats>;
