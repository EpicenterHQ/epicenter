import { createChats } from './chat/chats.js';
import type { VocabFolder } from './data.js';
import { createEntries } from './entries.svelte.js';

export function createVocab(folder: VocabFolder) {
	return { folder, entries: createEntries(folder), chats: createChats(folder) };
}

export type Vocab = ReturnType<typeof createVocab>;
