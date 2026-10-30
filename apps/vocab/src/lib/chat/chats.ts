import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type Chat,
	type FocusItem,
	type RowOf,
	readChat,
	readRows,
	type UnreadableFile,
	type VocabFolder,
} from '../data.js';

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
export function listingOf(rows: readonly RowOf<'chats'>[]): ChatListing {
	const read = readRows('chats', rows, readChat);
	return {
		chats: read.rows.map(summaryOf).sort(byRecency),
		unreadable: read.unreadable,
	};
}

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
	const chat: Chat = {
		id: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		focus: focus.map(({ entryId, text }) => ({ entryId, text })),
	};
	const { error } = await chats.create(chat.id, {
		fields: { createdAt: chat.createdAt, focus: chat.focus },
	});
	return error ? ChatHistoryError.NotSaved({ cause: error }) : Ok(chat);
}

export function createChats(folder: VocabFolder) {
	return {
		get listing() {
			return listingOf(folder.tables.chats.rows);
		},
		start: (focus: readonly FocusItem[]) =>
			startChat(folder.tables.chats, focus),
	};
}

export type Chats = ReturnType<typeof createChats>;
