/**
 * Reactive context tracking the Folder close. All current
 * readers must see input fenced while accepted Folder work can still
 * write; retiring or remounting readers must not disconnect another view.
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
	const release = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const action = folder.run(async () => {
		started.resolve();
		await release.promise;
		expectOk(await folder.files.write('finished.txt', 'done'));
	});
	const readers: ReturnType<typeof follow<boolean>>[] = [];
	try {
		await started.promise;
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
		release.resolve();
		expectOk(await action);
		expect(await closing).toEqual([]);
	} finally {
		for (const reader of readers) reader.stop();
		release.resolve();
		await context.close();
	}
});
