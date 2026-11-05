/**
 * Capture's page state (`createCaptures`) over a folder at a new place in
 * memory (`@epicenter/folder/memory`), in place of the folder the page is
 * given, read through `reactive` as `$lib/app` reads its own. The folder's
 * writes can be made to fail, or to wait until released, the way a lost
 * connection or a slow write would, and another program can write its
 * files.
 *
 * Import `svelte-dom.test-support.js` (or `svelte-modules`) first: the store
 * and `reactive` need Svelte's client runtime.
 */
import { openFolder } from '@epicenter/folder';
import { memory, memoryFiles } from '@epicenter/folder/memory';
import { capture } from './model/index.js';

const { reactive } = await import('@epicenter/svelte/reactive');
const { follow } = await import(
	'../../../../packages/svelte/src/reactive.test-support.svelte.js'
);
const { flushSync } = await import('svelte');
const { createCaptures } = await import('./captures.svelte.ts');

type Files = Record<string, string | Uint8Array>;

/**
 * Wait for `check`, flushing Svelte's effects between looks. The wait ends
 * before bun's 5 s per test, so one that runs out fails here, saying so.
 */
export async function until(
	check: () => boolean | Promise<boolean>,
	timeout = 4000,
) {
	const end = Date.now() + timeout;
	flushSync();
	while (!(await check())) {
		if (Date.now() > end) throw new Error('Timed out waiting');
		await Bun.sleep(5);
		flushSync();
	}
}

/**
 * The capture store over a folder holding `files`, as the page composes it.
 * Writes fail or wait on command.
 */
export async function openCaptures(files: Files = {}) {
	const place = memory();
	const outside = memoryFiles(place);
	for (const [path, data] of Object.entries(files))
		await outside.write(path, data);
	const folder = openFolder(capture, place);
	const list = reactive(folder).captures;
	const captures = createCaptures(list);
	// Read the list in an effect, as the page does, so it lists and listens.
	const watching = follow(() => [list.items(), list.invalid(), list.loading()]);
	await until(() => !list.loading());

	return {
		captures,
		list,
		/** The text at `path` in the folder, or null. */
		text: async (path: string) => outside.read(path),
		/** Every file in the folder, by path. */
		files: async () => outside.paths(),
		/** Write `path` in the folder as another tab or program would. */
		writeElsewhere: (path: string, text: string) => outside.write(path, text),
		/** Delete `path` in the folder as another tab or program would. */
		deleteElsewhere: (path: string) => outside.write(path, null),
		/** Fail every write until the returned function is called. */
		failWrites: (reason = 'the disk is full') => outside.refuse(reason),
		/** Hold every write until the returned function is called. */
		holdWrites: () => outside.hold(),
		async close() {
			watching.stop();
			folder[Symbol.dispose]();
		},
	};
}
export type CapturesHarness = Awaited<ReturnType<typeof openCaptures>>;
