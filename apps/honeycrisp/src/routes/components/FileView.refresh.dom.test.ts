/**
 * File editing during cache refresh. Background reads keep the existing text
 * editable; failed exact-source input stays visible after the saved file is
 * replaced by binary content. The mounted view uses real IndexedDB storage.
 */
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { type } from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
const { flushSync, mount, unmount } = await import('svelte');
const { openNotes, quiet, until } = await import(
	'../../lib/local.test-support.ts'
);
const FileView = (await import('./FileView.svelte')).default;
const Host = (await import('../../lib/ui-host.test-support.svelte')).default;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	document.body.replaceChildren();
});
async function open() {
	const fixture = await openNotes();
	await fixture.write('draft.txt', 'Original text');
	fixture.observe('draft.txt');
	await quiet(fixture.notes);
	const target = document.createElement('main');
	document.body.append(target);
	const view = mount(Host, {
		target,
		props: {
			client: fixture.notes.queryClient,
			component: FileView as never,
			props: { notes: fixture.notes, path: 'draft.txt' },
		},
	});
	cleanups.push(async () => {
		await unmount(view);
		await fixture.close();
	});
	const input = () =>
		target.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="Contents of draft.txt"]',
		);
	await until(() => {
		flushSync();
		return input()?.value === 'Original text';
	}, 'the file editor');
	return { ...fixture, target, input };
}

test('a background reread leaves the saved text editable', async () => {
	const { folder, local, input } = await open();
	const read = folder.files.read;
	const gate = Promise.withResolvers<void>();
	let waiting = false;
	folder.files.read = async (...args) => {
		if (args[0] === 'draft.txt') {
			waiting = true;
			await gate.promise;
		}
		return read(...args);
	};
	cleanups.push(() => {
		folder.files.read = read;
		gate.resolve();
	});
	const refreshing = local.refresh({
		queryKey: [...local.queries.key, 'file', 'draft.txt'],
		exact: true,
	});
	await until(() => waiting, 'a background read');
	flushSync();
	expect(input()?.readOnly).toBe(false);
	type(input(), 'Typed during refresh');
	flushSync();
	expect(input()?.value).toBe('Typed during refresh');
	gate.resolve();
	await refreshing;
	flushSync();
	expect(input()?.value).toBe('Typed during refresh');
});

test('failed source input stays visible when the saved file becomes binary', async () => {
	const { notes, otherTab, failSaves, local, input } = await open();
	type(input(), 'Keep this unsaved text');
	flushSync();
	failSaves();
	await notes.saveText('draft.txt');
	flushSync();
	expect(input()?.value).toBe('Keep this unsaved text');
	failSaves(false);
	const other = await otherTab();
	const before = expectOk(await other.files.read('draft.txt'))!;
	expectOk(
		await other.files.write(
			'draft.txt',
			new Uint8Array(await before.content.arrayBuffer()),
			new Uint8Array([0, 1, 2]),
		),
	);
	await local.refresh({
		queryKey: [...local.queries.key, 'file', 'draft.txt'],
		exact: true,
	});
	flushSync();
	expect(input()?.value).toBe('Keep this unsaved text');
	expect(notes.typedText('draft.txt')).toBe('Keep this unsaved text');
});
