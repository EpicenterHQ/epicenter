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
import { openFolder } from '@epicenter/folder/browser';
import { QueryObserver } from '@tanstack/query-core';
import { expectOk } from 'wellcrafted/testing';
import type { Captures } from './captures.svelte.js';

const open = async (saveAfterMs?: number) =>
	expectOk(await openFolder({ tables: captureTables, saveAfterMs }));

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
	const folder = await open(saveAfterMs);
	for (const [path, text] of Object.entries(files))
		expectOk(await folder.files.write(path, text));
	// Loaded on use, after the test file registered its runes-module loader.
	const { createFolderContext } = await import('@epicenter/svelte/folder');
	const { createCaptures } = await import('./captures.svelte.ts');
	const context = createFolderContext(folder);
	const captures: Captures = createCaptures(context);
	const observer = new QueryObserver(
		context.queryClient,
		context.queries.rows('captures'),
	);
	const stopObserving = observer.subscribe(() => {});
	await until(() => observer.getCurrentResult().data !== undefined, 'the rows');
	// Stand in for the edit subscription mounted by a capture detail.
	for (const path of Object.keys(files))
		expectOk(await folder.files.document(path).refresh());
	const other = await open();

	/** Nothing typed waits, no save runs, and nothing is read. */
	const idle = () =>
		!context.getStatus().saving &&
		context.getStatus().unsaved.length === 0 &&
		context.queryClient.isFetching() === 0;
	/** Storage refusals to undo when the harness closes. */
	const restores: (() => void)[] = [];

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
			expectOk(await other.files.write(path, text));
		},
		/** Another tab deletes the capture as it is now. */
		async deleteElsewhere(stem: string) {
			expectOk(await other.tables.captures.delete(stem));
		},
		/**
		 * Every save, of a row or a file's text, is refused by storage, as a
		 * full disk refuses it, until the answered `restore` runs.
		 */
		failSaves() {
			const put = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = () => {
				throw new DOMException('the disk is full', 'QuotaExceededError');
			};
			const restore = () => {
				IDBObjectStore.prototype.put = put;
			};
			restores.push(restore);
			return restore;
		},
		async close() {
			for (const restore of restores.splice(0).reverse()) restore();
			stopObserving();
			await context.close();
			await other.close();
		},
	};
}

export type CapturesHarness = Awaited<ReturnType<typeof openCaptures>>;

/** Missing is the latest acquisition outcome, even with retained editable text. */
export function isMissing(edit: {
	getSnapshot(): { loadError: { name: string } | undefined };
}) {
	return edit.getSnapshot().loadError?.name === 'Missing';
}
