/**
 * Vocab over a folder in memory, for tests: a folder opened at its own
 * `memory()` place in place of the folder `$lib/app.js` opens. Its words,
 * chats and messages as the page reads them (read through `reactive`), the
 * words and chats kept listing as an open page keeps them, the place's files
 * as another program reads and writes them (`memoryFiles`, which also holds
 * the folder's writes or refuses them below one directory, the way a slow
 * write or a lost connection would), and another program's folder at the
 * same place.
 *
 * Import after `svelte-modules.test-support.js`, which compiles the runes.
 */
import { openFolder } from '@epicenter/folder';
import type { Folder } from '@epicenter/folder/core';
import { memory, memoryFiles } from '@epicenter/folder/memory';
import { reactive } from '@epicenter/svelte/reactive';
import { flushSync } from 'svelte';
import { type Vocab, vocab } from './contract.js';

const { follow } = await import(
	'../../../../packages/svelte/src/reactive.test-support.svelte.js'
);

/** Vocab's folder at a new place in memory holding `initial`; `using` closes it. */
export async function openVocabFolder(initial: Record<string, string> = {}) {
	const place = memory();
	const files = memoryFiles(place);
	for (const [path, text] of Object.entries(initial))
		await files.write(path, text);
	const others: Folder<Vocab>[] = [];
	// As the page reads them: the folder, read through `reactive`.
	const lists = reactive(openFolder(vocab, place));
	const followed = follow(() => [
		lists.entries.items(),
		lists.entries.invalid(),
		lists.chats.items(),
		lists.chats.invalid(),
	]);
	await until(() => !lists.entries.loading() && !lists.chats.loading());
	return {
		lists,
		/** Every chat's messages, as a conversation is given them (`folder.messages`). */
		messages: lists.messages,
		/**
		 * The place's files as another program reads and writes them, and the
		 * folder's own writes held (`hold`) or refused below a directory
		 * (`refuse`, `refuseReads`).
		 */
		files,
		/** Another program's folder at the same place, closed with this one. */
		other() {
			const other = openFolder(vocab, place);
			others.push(other);
			return other;
		},
		[Symbol.dispose]() {
			followed.stop();
			for (const other of others) other[Symbol.dispose]();
			lists[Symbol.dispose]();
		},
	};
}

/** Wait, flushing effects, until `check` holds. */
export async function until(check: () => boolean, timeout = 4000) {
	const end = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > end) throw new Error('until: timed out');
		await Bun.sleep(5);
		flushSync();
	}
}

/** Wait until a conversation neither generates nor saves. */
export async function settle(conversation: {
	snapshot(): { isGenerating: boolean; isSaving: boolean };
}) {
	while (
		conversation.snapshot().isGenerating ||
		conversation.snapshot().isSaving
	)
		await new Promise<void>((resolve) => setImmediate(resolve));
}
