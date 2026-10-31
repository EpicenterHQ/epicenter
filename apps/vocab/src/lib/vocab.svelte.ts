/**
 * Vocab's state: its three collections as the lists the views read and
 * write (decision 12), and the word and chat stores over them. Each list is
 * this browser's notes signed out and, signed in, `oneList` over them and
 * the learner's `vocab` repository; `VocabApp` makes them.
 */
import type { NoteList } from '@epicenter/svelte/client';
import { createChats } from './chat/chats.js';
import type { Vocab } from './contract.js';
import { createEntries } from './entries.svelte.js';

export type VocabLists = {
	[K in keyof Vocab['collections']]: NoteList<Vocab['collections'][K]>;
};

/** `uploads`: signed in, so a word still on this device is "not uploaded yet". */
export function createVocab(
	lists: VocabLists,
	{ uploads }: { uploads: boolean },
) {
	return {
		lists,
		entries: createEntries(lists.entries, { uploads }),
		chats: createChats(lists.chats),
	};
}

export type VocabState = ReturnType<typeof createVocab>;
