/**
 * Cache identity for every query and mutation Vocab runs (ADR-0528,
 * ADR-0548); the rules they share are `<FolderApp>`'s query client's. Every folder read is a query under the folder's own
 * keys (`folderOptions`), so a change the folder reports reaches it; every
 * write and action is a mutation.
 */
import type { FolderOptions } from '@epicenter/folder/query';
import { defineKeys } from 'wellcrafted/query';
import type { vocabFolder } from './data.js';

/** The query option factories over Vocab's opened folder. */
export type VocabOptions = FolderOptions<typeof vocabFolder>;

/** Keys of Vocab's own actions; reads and row saves use the folder's keys. */
export const vocabKeys = defineKeys({
	/** Every action Vocab defines itself. */
	all: ['vocab'],
	add: ['vocab', 'add'],
	delete: (path: string) => ['vocab', 'delete', path] as const,
	startChat: ['vocab', 'start-chat'],
	/** Every message write of one chat. */
	message: (chatId: string) => ['vocab', 'message', chatId] as const,
});

/** Why a change did not start: the page is closing. */
export const CLOSING = 'Vocab is closing, so nothing was changed.';
