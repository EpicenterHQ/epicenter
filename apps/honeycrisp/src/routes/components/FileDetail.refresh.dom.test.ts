/**
 * File editing during cache refresh. Background reads keep the existing text
 * editable; failed exact-source input stays visible after the saved file is
 * replaced by binary content. Failed row input stays available when its file
 * disappears. The mounted view uses real IndexedDB storage.
 */
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
const { unsavedOf, isMissing } = await import(
	'../../lib/local.test-support.js'
);
import { afterEach, expect, test } from 'bun:test';
import { ReadError } from '@epicenter/folder';
import { expectOk } from 'wellcrafted/testing';
import {
	click,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { openNotes, noteText, quiet, until } = await import(
	'../../lib/local.test-support.ts'
);
const FileDetail = (await import('./FileDetail.svelte')).default;
const Host = (await import('../../lib/ui-host.test-support.svelte')).default;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	document.body.replaceChildren();
});
async function open(path = 'draft.txt', content = 'Original text') {
	const fixture = await openNotes();
	await fixture.write(path, content);
	fixture.observe(path);
	await quiet(fixture.notes);
	const target = document.createElement('main');
	document.body.append(target);
	const view = mount(Host, {
		target,
		props: {
			client: fixture.notes.queryClient,
			component: FileDetail as never,
			props: { notes: fixture.notes, path, as: 'text' },
		},
	});
	cleanups.push(async () => {
		await unmount(view);
		await fixture.close();
	});
	const input = () =>
		target.querySelector<HTMLTextAreaElement>(
			`textarea[aria-label="Contents of ${path.split('/').at(-1)}"]`,
		);
	await until(() => {
		flushSync();
		return input()?.value === content;
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
	const refreshing = local.refresh(['draft.txt']);
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

test('saved words stay shown when the reread fails, and typing on keeps them', async () => {
	const { folder, notes, local, input, text } = await open();
	const read = folder.files.read;
	folder.files.read = async (path) =>
		path === 'draft.txt'
			? ReadError.StorageFailed({ cause: new Error('read refused') })
			: read(path);
	cleanups.push(() => {
		folder.files.read = read;
	});
	type(input(), 'Committed words');
	flushSync();
	await notes.folder.files.edit('draft.txt').save();
	await local.refresh(['draft.txt']);
	flushSync();
	expect(unsavedOf(folder.files.edit('draft.txt'))).toBeUndefined();
	expect(await text('draft.txt')).toBe('Committed words');
	expect(input()?.value).toBe('Committed words');
	expect(input()?.readOnly).toBe(false);

	type(input(), 'Committed words, and more');
	flushSync();
	await notes.folder.files.edit('draft.txt').save();
	expect(await text('draft.txt')).toBe('Committed words, and more');
	folder.files.read = read;
	await local.refresh(['draft.txt']);
	flushSync();
	expect(input()?.value).toBe('Committed words, and more');
});

test('failed source input stays visible when the saved file becomes binary', async () => {
	const { notes, otherTab, failSaves, local, input } = await open();
	type(input(), 'Keep this unsaved text');
	flushSync();
	failSaves();
	await notes.folder.files.edit('draft.txt').save();
	flushSync();
	expect(input()?.value).toBe('Keep this unsaved text');
	failSaves(false);
	const other = await otherTab();
	const before = expectOk(await other.files.read('draft.txt'));
	if (before === undefined) throw new Error('The test file disappeared');
	expectOk(
		await other.files.write(
			'draft.txt',
			new Uint8Array(await before.content.arrayBuffer()),
			new Uint8Array([0, 1, 2]),
		),
	);
	await local.refresh(['draft.txt']);
	flushSync();
	expect(input()?.value).toBe('Keep this unsaved text');
	expect(notes.folder.files.edit('draft.txt').getText()).toBe(
		'Keep this unsaved text',
	);
});

test('failed row changes remain available after deletion until explicit replacement restores them', async () => {
	const path = 'notes/a.md';
	const { notes, folder, otherTab, failSaves, local, target, text } =
		await open(path, noteText());
	notes.folder.tables.notes
		.edit(path.slice('notes/'.length, -3))
		.change({ body: 'Keep my row changes\n' });
	failSaves();
	await folder.files.edit(path).save();
	failSaves(false);
	const other = await otherTab();
	const stored = expectOk(await other.files.read(path));
	if (stored === undefined) throw new Error('The test note disappeared');
	expectOk(
		await other.files.delete(
			path,
			new Uint8Array(await stored.content.arrayBuffer()),
		),
	);
	await local.refresh([path]);
	await until(() => {
		flushSync();
		return isMissing(folder.files.edit(path));
	}, 'the missing note');
	expect(inputForRecovery(target)).toContain('Keep my row changes');
	expect(target.textContent).toContain('Save again');
	expect(target.textContent).toContain('Discard changes');
	click(target, 'Save again');
	await until(
		() => unsavedOf(folder.files.edit(path))?.error?.name === 'Conflict',
		'the deletion conflict',
	);
	click(target, 'Replace saved file');
	await until(
		() => unsavedOf(folder.files.edit(path)) === undefined,
		'the explicit retry',
	);
	expect(await text(path)).toContain('Keep my row changes');
});

test('a pinned field draft remains copyable beside broken stored source and can replace it', async () => {
	const path = 'notes/a.md';
	const { notes, folder, otherTab, failSaves, local, target, input, text } =
		await open(path, noteText());
	notes.folder.tables.notes
		.edit(path.slice('notes/'.length, -3))
		.change({ fields: { title: 'Keep this title' } });
	failSaves();
	await folder.files.edit(path).save();
	failSaves(false);
	const other = await otherTab();
	const before = await text(path);
	if (before === undefined) throw new Error('The test note disappeared');
	const broken = before.replace('\n---\n', '\n');
	expectOk(await other.files.write(path, before, broken));
	await local.refresh([path]);
	flushSync();
	expect(input()?.value).toContain('Keep this title');
	expect(target.querySelectorAll('[data-testid="write-status"]')).toHaveLength(
		1,
	);
	expect(
		[...target.querySelectorAll('button')].filter(
			(button) => button.textContent?.trim() === 'Save again',
		),
	).toHaveLength(1);
	click(target, 'Save again');
	await until(
		() => unsavedOf(folder.files.edit(path))?.error?.name === 'Conflict',
		'the broken header conflict',
	);
	expect(target.querySelector('[aria-label="Saved source"]')?.textContent).toBe(
		broken,
	);
	expect(inputForRecovery(target)).toContain('Keep this title');
	click(target, 'Replace saved file');
	await until(
		() => unsavedOf(folder.files.edit(path)) === undefined,
		'the explicit source replacement',
	);
	expect(await text(path)).toContain('Keep this title');
});

function inputForRecovery(target: ParentNode) {
	return target.querySelector('[aria-label="Unsaved source"]')?.textContent;
}
