/**
 * Reactive context tracking the Folder close. All current
 * readers must see input fenced; retiring or remounting readers must not
 * disconnect another view. Release does not wait for pending writes.
 */
import './svelte-modules.test-support.js';
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';

const { createFolderContext } = await import('./folder-context.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync, tick } = await import('svelte');

test('closing reaches every current reader after earlier readers unmount', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(await openFolder({ tables: {} }));
	const context = createFolderContext(folder);
	expectOk(await folder.files.write('finished.txt', 'done'));
	const readers: ReturnType<typeof follow<boolean>>[] = [];
	try {
		readers.push(
			follow(() => context.closing),
			follow(() => context.closing),
		);
		flushSync();
		expect(readers.map(({ values }) => values)).toEqual([[false], [false]]);
		for (const reader of readers) reader.stop();
		await tick();
		const first = follow(() => context.closing);
		const second = follow(() => context.closing);
		readers.push(first, second);
		flushSync();
		first.stop();
		await tick();
		const replacement = follow(() => context.closing);
		readers.push(replacement);
		flushSync();

		const closing = context.close();
		flushSync();
		expect(folder.getStatus().closing).toBe(true);
		expect(second.values).toEqual([false, true]);
		expect(replacement.values).toEqual([false, true]);
		expect(closing).toBeUndefined();
	} finally {
		for (const reader of readers) reader.stop();
		context.close();
	}
});

test('close releases immediately during a pending write and clears queries synchronously', async () => {
	const { folderHandle } = await import('../../folder/src/handle.js');
	const { Ok } = await import('wellcrafted/result');
	const blocked = Promise.withResolvers<void>();
	const reached = Promise.withResolvers<void>();
	let change: (() => void) | undefined;
	let closes = 0;
	let reads = 0;
	const folder = folderHandle({
		files: {
			async list() {
				reads++;
				return Ok([]);
			},
			async read() {
				return Ok(undefined);
			},
			async write() {
				reached.resolve();
				await blocked.promise;
				change?.();
				return Ok(undefined);
			},
			async delete() {
				return Ok(undefined);
			},
		},
		tables: {},
		subscribe(listener) {
			change = () => listener({ paths: null, origin: 'this-handle' });
			return () => {
				change = undefined;
			};
		},
		close() {
			closes++;
		},
	}, {});
	const context = createFolderContext(folder);
	const { QueryObserver } = await import('@tanstack/query-core');
	const observer = new QueryObserver(context.queryClient, context.queries.files());
	const stop = observer.subscribe(() => {});
	await context.queryClient.fetchQuery(context.queries.files());
	const writing = folder.files.write('a.md', 'A');
	await reached.promise;
	try {
		expect(context.queryClient.getQueryCache().getAll()).toHaveLength(1);
		expect(context.close()).toBeUndefined();
		expect(context.queryClient.getQueryCache().getAll()).toEqual([]);
		expect(closes).toBe(1);
		expect(context.close()).toBeUndefined();
		expect(closes).toBe(1);
		blocked.resolve();
		expectOk(await writing);
		expect(reads).toBe(1);
		expect(context.queryClient.getQueryCache().getAll()).toEqual([]);
	} finally {
		blocked.resolve();
		await writing;
		stop();
		context.close();
	}
});
