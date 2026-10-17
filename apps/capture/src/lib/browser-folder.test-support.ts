/**
 * Test helper: a real browser folder over the folder package's in-memory OPFS
 * stand-in, with the controls a test of the Capture store needs: hold a
 * Markdown save while it runs, count Markdown saves, fail the next write of
 * a path, change files as another program would, and report a change as the
 * folder's change channel does. The store gets its own mounted query client,
 * wired to that channel as the page wires it, with the capture listing
 * observed as the timeline observes it, and records every write that failed.
 *
 * Import a runes-module loader first (`packages/svelte/src/svelte-modules.test-support.js`
 * or `svelte-dom.test-support.js`); this module loads `captures.svelte.ts`.
 */
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/browser';
import { createFolderContext } from '@epicenter/svelte/folder';
import type { WriteFailure } from '@epicenter/svelte/write-failure';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import { holdCloses } from '../../../../packages/folder/src/opfs.test-support.js';
import type { Captures } from './captures.svelte.js';
import { observe, quiet } from './query.test-support.js';

let count = 0;

/** The Capture store over a fresh browser folder holding `files`, listed once. */
export async function openCaptures(files: Record<string, string> = {}) {
	const storage = createTestStorage();
	let hold: PromiseWithResolvers<void> | undefined;
	let held: PromiseWithResolvers<void> | undefined;
	const counter = { mdWrites: 0 };
	const app = `capture-test-${count++}`;
	const folder = expectOk(
		await openFolder({
			app,
			definition: captureDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
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
		expectOk(await folder.write(path, null, text));
	// Loaded on use, after the test file registered its runes-module loader.
	const { createCaptures } = await import('./captures.svelte.ts');
	const failures: WriteFailure[] = [];
	// The folder's context as `<FolderApp>` builds it, change wiring included.
	// One page per folder here, so it reports nothing; `reportChange` stands
	// in for another page's report.
	const opened = createFolderContext(folder, {
		writeFailed: (failure) => failures.push(failure),
	});
	const { queryClient } = opened;
	const captures: Captures = createCaptures(opened);
	const stopObserving = observe(captures);
	await quiet(captures);
	const faults = opfsOf(storage).faults;
	return {
		folder,
		opened,
		captures,
		counter,
		failures,
		/** The file's text now, or `undefined` when it is gone. */
		async text(path: string) {
			const read = await folder.files.read(path);
			return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
		},
		/** The file's text as another page reads it, as after this page closed. */
		async textElsewhere(path: string) {
			const other = expectOk(
				await openFolder({
					app,
					definition: captureDefinition,
					browser: browserStorage(storage),
				}),
			);
			const read = await other.files.read(path);
			await other.close();
			return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
		},
		/** Another program writes the file over whatever is there. */
		async writeElsewhere(path: string, text: string) {
			const current = await folder.files.read(path);
			expectOk(
				await folder.write(
					path,
					current.error === null ? current.data.bytes : null,
					text,
				),
			);
		},
		/** The folder's change channel reports `paths`, as for another page's writes. */
		async reportChange(...paths: string[]) {
			await queryClient.invalidateQueries(captures.queries.pathFilter(paths));
			await quiet(captures);
		},
		/** Another program deletes the file as it is now. */
		async deleteElsewhere(path: string) {
			expectOk(await folder.write(path, null, null));
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
			stopObserving();
			await opened.close();
		},
	};
}
