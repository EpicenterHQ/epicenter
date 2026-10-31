import type { NoteList } from '@epicenter/svelte/client';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
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

export type ChatList = NoteList<Vocab['collections']['chats']>;

export const ChatHistoryError = defineErrors({
	NotSaved: ({ cause }: { cause: unknown }) => ({
		message: `This chat was not saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
	InvalidFocus: () => ({ message: 'Choose one to three saved expressions.' }),
	Taken: ({ path }: { path: string }) => ({
		message: `Another message is already saved at '${path}'.`,
		path,
	}),
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
	invalid: ChatList['invalid'],
): ChatListing {
	return {
		chats: items.map(readChat).map(summaryOf).sort(byRecency),
		unreadable: invalid.map(({ path, issues }) => ({
			path,
			reason: reasonOf(issues),
		})),
	};
}

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
	const { error } = await chats.create({ ...chat, body: '' });
	return error ? ChatHistoryError.NotSaved({ cause: error }) : Ok(chat);
}

export function createChats(list: ChatList) {
	return {
		get listing() {
			return listingOf(list.items, list.invalid);
		},
		start: (focus: readonly FocusItem[]) => startChat(list, focus),
	};
}

export type Chats = ReturnType<typeof createChats>;
