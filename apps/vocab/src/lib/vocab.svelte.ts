/**
 * Vocab's state for one of its two views (decision 76): one client's three
 * collections, and the word and chat stores over them. "On this device"
 * reads this browser's files (`fromClient(device)`); "Synced" reads the
 * learner's `vocab` repository (`fromClient(getRepo<Vocab>())`). A view's
 * collections all come from its one client, so a chat's focus words and its
 * messages are always that client's.
 */
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createChats } from './chat/chats.js';
import type { Vocab } from './contract.js';
import { createEntries } from './entries.svelte.js';

/**
 * Which of Vocab's views a page is: this browser's files ("On this
 * device"), the learner's repository ("Synced"), or, in the desktop
 * program, the folder Vocab keeps its files in on this computer.
 */
export type View = 'device' | 'synced' | 'folder';

export function createVocab(client: ReactiveClient<Vocab>) {
	return {
		entries: createEntries(client.entries),
		chats: createChats(client.chats),
		messages: client.messages,
	};
}

export type VocabState = ReturnType<typeof createVocab>;
