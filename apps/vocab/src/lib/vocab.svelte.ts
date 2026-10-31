/**
 * Vocab's state: its three collections as the one lists the views read and
 * write (decision 12), each over this browser's files and, signed in, the
 * learner's `vocab` repository, and the word and chat stores over them.
 */
import {
	type CaptureQueue,
	type OneList,
	oneList,
	type ReactiveClient,
} from '@epicenter/svelte/client';
import { createChats } from './chat/chats.js';
import { type Vocab, vocab } from './contract.js';
import { createEntries } from './entries.svelte.js';

export type VocabLists = {
	[K in keyof Vocab['collections']]: OneList<Vocab['collections'][K]>;
};

/**
 * The one list of each collection over `device` (this browser's files) and
 * `repository` (null signed out). `outbox` is the device's: what is made
 * signed out, or while the server cannot be reached, waits there to upload.
 */
export function createVocabLists({
	device,
	repository,
	outbox,
}: {
	device: ReactiveClient<Vocab>;
	repository: ReactiveClient<Vocab> | null;
	outbox: CaptureQueue | null;
}): VocabLists {
	return {
		entries: oneList(vocab, 'entries', {
			device: device.entries,
			repository: repository?.entries ?? null,
			outbox,
		}),
		chats: oneList(vocab, 'chats', {
			device: device.chats,
			repository: repository?.chats ?? null,
			outbox,
		}),
		messages: oneList(vocab, 'messages', {
			device: device.messages,
			repository: repository?.messages ?? null,
			outbox,
		}),
	};
}

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
