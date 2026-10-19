/**
 * Test helper: the Capture store over a real local folder
 * (`openFolder({ tables: captureTables })`) on a fresh in-memory IndexedDB,
 * built as `<FolderApp>` builds it, with the rows query observed as the
 * timeline observes it. A second handle of the same profile stands in for
 * another tab of Capture: its saves reach the store's folder on the change
 * channel, as another tab's do.
 *
 * Import `fake-indexeddb/auto` and a runes-module loader from
 * `packages/svelte/src` first (`svelte-modules.test-support.js` or
 * `svelte-dom.test-support.js`); this module loads the runes modules on use.
 */
import { type CaptureRow, captureTables } from '@epicenter/capture';
import { openFolder, type SaveError } from '@epicenter/folder/browser';
import { QueryObserver } from '@tanstack/query-core';
import { Err } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { Captures } from './captures.svelte.js';

const open = async () => expectOk(await openFolder({ tables: captureTables }));

/** A save storage refused, as the folder reports it. */
const refused = () =>
	Err({
		name: 'StorageFailed',
		message: 'Repository save failed: the disk is full',
		cause: new Error('the disk is full'),
	} as Extract<SaveError, { name: 'StorageFailed' }>);

/** Wait until `check` holds, letting saves, reads, and timers run. */
export async function until(check: () => boolean, what = 'the check') {
	for (let tries = 0; tries < 400; tries++) {
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/**
 * The Capture store over a fresh profile holding `files`, listed once.
 * Drafts save `saveAfterMs` after the last change.
 */
export async function openCaptures(
	files: Record<string, string> = {},
	{ saveAfterMs = 20 } = {},
) {
	// A fresh profile: the classes `fake-indexeddb/auto` installed.
	globalThis.indexedDB = new IDBFactory();
	const folder = await open();
	for (const [path, text] of Object.entries(files))
		expectOk(await folder.files.write(path, null, text));
	// Loaded on use, after the test file registered its runes-module loader.
	const { createFolderContext } = await import(
		'@epicenter/svelte/folder'
	);
	const { createCaptures } = await import('./captures.svelte.ts');
	const context = createFolderContext(folder, { saveAfterMs });
	const captures: Captures = createCaptures(context);
	const observer = new QueryObserver(
		context.queryClient,
		context.queries.rows('captures'),
	);
	const stopObserving = observer.subscribe(() => {});
	await until(() => observer.getCurrentResult().data !== undefined, 'the rows');
	const other = await open();

	/** Nothing typed waits, no save runs, and nothing is read. */
	const idle = () =>
		!context.busy &&
		!captures.texts.busy &&
		context.queryClient.isFetching() === 0;

	return {
		folder,
		context,
		captures,
		/** The rows the cache holds now, as the timeline reads them. */
		rows: (): CaptureRow[] => observer.getCurrentResult().data ?? [],
		/** The row the cache holds for `stem`. */
		cached(stem: string): CaptureRow | undefined {
			return observer.getCurrentResult().data?.find((row) => row.id === stem);
		},
		/** Wait until every draft saved and the rows were read again. */
		async quiet() {
			await until(idle, 'saves to land');
			await Bun.sleep(0);
			await until(idle, 'saves to land');
		},
		/** The file's text as another tab reads it, or `undefined` when it is gone. */
		async text(path: string) {
			const read = expectOk(await other.files.read(path));
			return read === undefined ? undefined : read.content.text();
		},
		/** Another tab saves `text` over the file as it is now. */
		async writeElsewhere(path: string, text: string) {
			const read = expectOk(await other.files.read(path));
			const current = read === undefined ? null : await read.content.text();
			expectOk(await other.files.write(path, current, text));
		},
		/** Another tab deletes the capture as it is now. */
		async deleteElsewhere(stem: string) {
			const row = expectOk(await other.tables.captures.get(stem));
			expectOk(await other.tables.captures.delete(stem, row ?? null));
		},
		/** The next save of a capture's row is refused by storage. */
		failNextRowSave() {
			const set = folder.tables.captures.set;
			folder.tables.captures.set = async () => {
				folder.tables.captures.set = set;
				return refused();
			};
		},
		/** The next save of a file's text is refused by storage. */
		failNextFileWrite() {
			const write = folder.files.write;
			folder.files.write = async () => {
				folder.files.write = write;
				return refused();
			};
		},
		/** Hold the next save of a capture's row until `release` runs. */
		holdNextRowSave() {
			const set = folder.tables.captures.set;
			const gate = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			folder.tables.captures.set = async (...args) => {
				folder.tables.captures.set = set;
				held.resolve();
				await gate.promise;
				return set(...args);
			};
			return { held: held.promise, release: () => gate.resolve() };
		},
		async close() {
			stopObserving();
			await context.close();
			await other.close();
		},
	};
}

export type CapturesHarness = Awaited<ReturnType<typeof openCaptures>>;
