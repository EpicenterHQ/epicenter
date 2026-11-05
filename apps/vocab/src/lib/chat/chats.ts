import type { FolderNotes } from '@epicenter/folder/core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Vocab } from '../contract.js';
import {
	type Chat,
	type ChatNote,
	type FocusItem,
	readChat,
	reasonOf,
	type UnreadableFile,
} from '../data.js';

/** The chat notes, as the folder shows them (`folder.chats` from `$lib/app.js`, read through `reactive`). */
export type ChatList = FolderNotes<Vocab['collections']['chats']>;

export const ChatHistoryError = defineErrors({
	InvalidFocus: () => ({ message: 'Choose one to three saved expressions.' }),
});
export type ChatHistoryError = InferErrors<typeof ChatHistoryError>;

export type ChatSummary = {
	id: string;
	title: string;
	focus: FocusItem[];
	updatedAt: number;
};
export type ChatListing = {
	chats: ChatSummary[];
	unreadable: UnreadableFile[];
};

export function summaryOf(chat: Chat): ChatSummary {
	return {
		id: chat.id,
		title: chat.focus.map((item) => item.text).join(', '),
		focus: chat.focus,
		updatedAt: Date.parse(chat.createdAt),
	};
}
export const byRecency = (a: ChatSummary, b: ChatSummary) =>
	b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
export function listingOf(
	items: readonly ChatNote[],
	invalid: ReturnType<ChatList['invalid']>,
): ChatListing {
	return {
		chats: items.map(readChat).map(summaryOf).sort(byRecency),
		unreadable: invalid.map(({ path, issues }) => ({
			path,
			reason: reasonOf(issues),
		})),
	};
}

/** Save a new chat of `focus`, answering once it has landed; a focus of none or more than three is refused. */
export async function startChat(
	chats: ChatList,
	focus: readonly FocusItem[],
): Promise<Result<Chat, ChatHistoryError>> {
	if (
		focus.length < 1 ||
		focus.length > 3 ||
		focus.some((item) => !item.entryId || !item.text.trim())
	)
		return ChatHistoryError.InvalidFocus();
	const chat: Chat = {
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		focus: focus.map(({ entryId, text }) => ({ entryId, text })),
	};
	await chats.set({ id: chat.id }, { createdAt: chat.createdAt, focus: chat.focus });
	return Ok(chat);
}

export function createChats(list: ChatList) {
	return {
		get listing() {
			return listingOf(list.items(), list.invalid());
		},
		start: (focus: readonly FocusItem[]) => startChat(list, focus),
	};
}

export type Chats = ReturnType<typeof createChats>;
