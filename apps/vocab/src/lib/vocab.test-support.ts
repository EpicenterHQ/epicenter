/**
 * Vocab over a real device folder, for tests: a node device in a temporary
 * directory (`openDevice` from `@epicenter/folder/node`, the same contract
 * client and paths as the browser's), the app's one lists over it, kept
 * listing as an open page keeps them, and a way to hold or refuse writes.
 *
 * Import after `svelte-modules.test-support.js`, which compiles the runes.
 */
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Client, ClientError } from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/node';
import { fromClient } from '@epicenter/svelte/client';
import { flushSync } from 'svelte';
import { type Vocab, vocab } from './contract.js';
import { createVocabLists } from './vocab.svelte.js';

const { follow } = await import(
	'../../../../packages/svelte/src/reactive.test-support.svelte.js'
);

/** What a test does to the device's writes. */
export type WriteControl = {
	/** Every write waits for this, when set. */
	gate?: Promise<void>;
	/** A write to a collection this answers true for is refused, `Unavailable`. */
	refuse?: (collection: keyof Vocab['collections']) => boolean;
};

const WRITES = ['create', 'update', 'replace', 'delete'] as const;

/** `client`, with every write passing through `control` first. */
function controlled(client: Client<Vocab>, control: WriteControl) {
	return Object.fromEntries(
		Object.entries(client).map(([name, collection]) => [
			name,
			{
				...collection,
				...Object.fromEntries(
					WRITES.filter((write) => write in collection).map((write) => [
						write,
						async (...args: unknown[]) => {
							await control.gate;
							if (control.refuse?.(name as keyof Vocab['collections']))
								return ClientError.Unavailable({
									cause: 'refused by the test',
								});
							// SAFETY: the write is the collection's own, called as given.
							return (
								collection as unknown as Record<
									string,
									(...args: unknown[]) => unknown
								>
							)[write]?.(...args);
						},
					]),
				),
			},
		]),
	) as Client<Vocab>;
}

/** Vocab's device over a fresh directory; `await using` removes it. */
export async function openVocabFolder(initial: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), 'vocab-'));
	for (const [path, text] of Object.entries(initial)) {
		await mkdirFor(join(root, path));
		await writeFile(join(root, path), text);
	}
	const control: WriteControl = {};
	const client = openDevice(vocab, { path: root });
	const files = fromClient(controlled(client, control));
	const lists = createVocabLists({
		device: files,
		repository: null,
		outbox: null,
	});
	const followed = follow(() => [
		lists.entries.items,
		lists.entries.invalid,
		lists.chats.items,
		lists.chats.invalid,
		lists.messages.items,
		lists.messages.invalid,
	]);
	await until(() => !lists.entries.loading && !lists.chats.loading);
	return {
		root,
		client,
		lists,
		control,
		/** Another program's client of the same folder. */
		other: () => openDevice(vocab, { path: root }),
		/** Write a file as another program would. */
		async write(path: string, text: string) {
			await mkdirFor(join(root, path));
			await writeFile(join(root, path), text);
		},
		text: (path: string) =>
			readFile(join(root, path), 'utf8').catch(() => undefined),
		/** The files below `directory`, by path. */
		async files(directory: string) {
			const names = await readdir(join(root, directory), {
				recursive: true,
				withFileTypes: true,
			}).catch(() => []);
			return names
				.filter((entry) => entry.isFile())
				.map((entry) =>
					join(entry.parentPath, entry.name).slice(root.length + 1),
				)
				.sort();
		},
		async [Symbol.asyncDispose]() {
			followed.stop();
			await rm(root, { recursive: true, force: true });
		},
	};
}

const mkdirFor = (path: string) => mkdir(dirname(path), { recursive: true });

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
