/**
 * Vocab's state over the client it is given: its three collections, and the
 * word and chat stores over them. The root that passes the client decides
 * the store; in the browser it is the learner's `vocab` repository
 * (`getRepo<Vocab>()`, wrapped once where the signed-in root set it,
 * ADR-0700). All three collections come from that one client, so a chat's
 * focus words and its messages are always that client's.
 */
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createChats } from './chat/chats.js';
import type { Vocab } from './contract.js';
import { createEntries } from './entries.svelte.js';

export function createVocab(client: ReactiveClient<Vocab>) {
	return {
		entries: createEntries(client.entries),
		chats: createChats(client.chats),
		messages: client.messages,
	};
}

export type VocabState = ReturnType<typeof createVocab>;
