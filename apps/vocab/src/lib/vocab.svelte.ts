/**
 * Vocab's state over its store's three collections: the word and chat
 * stores over them, and the messages. The variant's root decides the store
 * (the learner's `vocab` repository on the web, ADR-0700, or the desktop
 * window's folder) and sets each collection where it opens it
 * (`setEntryList`, `setChatList`, `setMessageList`). All three come from
 * that one client, so a chat's focus words and its messages are always that
 * client's.
 */

import type { NoteClient } from '@epicenter/definition/contract';
import { createContext } from 'svelte';
import { type ChatList, createChats } from './chat/chats.js';
import type { Vocab } from './contract.js';
import { createEntries, type EntryList } from './entries.svelte.js';

/** Every chat's finished messages, as the client keeps them: each tutor conversation lists and writes its own. */
export type MessageList = NoteClient<Vocab['collections']['messages']>;

/** The page's words, set by the variant's root. */
export const [getEntryList, setEntryList] = createContext<EntryList>();
/** The page's chats, set by the variant's root. */
export const [getChatList, setChatList] = createContext<ChatList>();
/** The page's messages, set by the variant's root. */
export const [getMessageList, setMessageList] = createContext<MessageList>();

export function createVocab({
	entries,
	chats,
	messages,
}: {
	entries: EntryList;
	chats: ChatList;
	messages: MessageList;
}) {
	return {
		entries: createEntries(entries),
		chats: createChats(chats),
		messages,
	};
}

export type VocabState = ReturnType<typeof createVocab>;
