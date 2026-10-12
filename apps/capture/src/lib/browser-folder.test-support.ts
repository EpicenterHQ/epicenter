/**
 * Test helper: a real browser folder over the folder package's in-memory OPFS
 * stand-in, with the controls a test of the Capture store needs: hold a
 * Markdown save while it runs, count Markdown saves, fail the next write of
 * a path, and change files as another program would.
 *
 * Import a runes-module loader first (`svelte-modules.test-support.js` or
 * `svelte-dom.test-support.js`); this module loads `captures.svelte.ts`.
 */
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	createTestStorage,
	opfsOf,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import type {
	OpfsDirectoryHandle,
	OpfsFileHandle,
} from '../../../../packages/folder/src/opfs-store.js';
import type { Captures } from './captures.svelte.js';

/**
 * OPFS handles that call `beforeClose` with a file's own handle before a
 * stream to it publishes: the window in which a save is running.
 */
function holdCloses(
	directory: OpfsDirectoryHandle,
	beforeClose: (file: OpfsFileHandle) => Promise<void>,
): OpfsDirectoryHandle {
	const holdFile = (file: OpfsFileHandle): OpfsFileHandle => ({
		kind: 'file',
		name: file.name,
		getFile: () => file.getFile(),
		async createWritable(options) {
			const writable = await file.createWritable(options);
			return {
				write: (data) => writable.write(data),
				abort: (reason) => writable.abort(reason),
				async close() {
					await beforeClose(file);
					return writable.close();
				},
			};
		},
	});
	return {
		kind: 'directory',
		name: directory.name,
		getDirectoryHandle: async (name, options) =>
			holdCloses(
				await directory.getDirectoryHandle(name, options),
				beforeClose,
			),
		getFileHandle: async (name, options) =>
			holdFile(await directory.getFileHandle(name, options)),
		removeEntry: (name, options) => directory.removeEntry(name, options),
		async *values() {
			for await (const entry of directory.values())
				yield entry.kind === 'file'
					? holdFile(entry)
					: holdCloses(entry, beforeClose);
		},
	};
}

let count = 0;

/** The Capture store over a fresh browser folder holding `files`, listed once. */
export async function openCaptures(files: Record<string, string> = {}) {
	const storage = createTestStorage();
	let hold: PromiseWithResolvers<void> | undefined;
	let held: PromiseWithResolvers<void> | undefined;
	const counter = { mdWrites: 0 };
	const folder = expectOk(
		await openFolder({
			id: `capture-test-${count++}`,
			definition: captureDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				opfs: {
					locks: testLocks,
					getDirectory: async () =>
						holdCloses(await storage.opfs.getDirectory(), async (file) => {
							if (!file.name.endsWith('.md')) return;
							counter.mdWrites++;
							const gate = hold;
							if (gate === undefined) return;
							hold = undefined;
							held?.resolve();
							await gate.promise;
						}),
				},
			},
		}),
	);
	for (const [path, text] of Object.entries(files))
		expectOk(await folder.files.create(path, text));
	// Loaded on use, after the test file registered its runes-module loader.
	const { createCaptures } = await import('./captures.svelte.ts');
	// The harness keeps the folder open past the store's close, so a test can
	// read what closing saved; `close` below releases it.
	const captures: Captures = createCaptures({
		folder,
		location: folder.location,
		close: async () => {},
	});
	await captures.refresh();
	const faults = opfsOf(storage).faults;
	return {
		folder,
		captures,
		counter,
		/** The file's text now, or `undefined` when it is gone. */
		async text(path: string) {
			const read = await folder.files.read(path);
			return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
		},
		/** Another program writes the file. */
		async writeElsewhere(path: string, text: string) {
			expectOk(await folder.files.overwrite(path, text));
		},
		/** Another program deletes the file as it is now. */
		async deleteElsewhere(path: string) {
			expectOk(
				await folder.files.remove(expectOk(await folder.files.read(path))),
			);
		},
		/** Hold the next published `.md` write until `release` runs. */
		holdNextMarkdownWrite() {
			hold = Promise.withResolvers<void>();
			held = Promise.withResolvers<void>();
			return { held: held.promise, release: hold.resolve };
		},
		/** The next write of `path` fails before it publishes. */
		failNextWrite(path: string) {
			faults.write = (file) => {
				if (!file.endsWith(`/${path}`)) return undefined;
				faults.write = undefined;
				return 'fail';
			};
		},
		async close() {
			await captures.close();
			await folder.close();
		},
	};
}

/** The open capture's row session and form; throws when another kind is open. */
export function openCapture(captures: Captures) {
	const item = captures.opened;
	if (item?.kind !== 'capture')
		throw new Error(`Expected an open capture, got ${item?.kind}`);
	return item;
}

/** The open text session; throws when another kind is open. */
export function openText(captures: Captures) {
	const item = captures.opened;
	if (item?.kind !== 'text')
		throw new Error(`Expected open text, got ${item?.kind}`);
	return item.session;
}
