/**
 * `svelteFolder` and `draft` over an in-memory host, read in effects as
 * components do.
 *
 * Key behaviors:
 * - `rows`, `row(id)`, and `files` are tracked: an effect reruns when they change
 * - `row(id)` answers the same object until that row changes
 * - A draft shows typing until its save answers, then follows the disk
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { createFolder, memoryHost } from '@epicenter/folder/next/testing';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import type { SvelteTable } from './folder-next.js';
import { desktop, nativeWindow } from './tauri-window.test-support.js';

const { svelteFolder } = await import('./folder-next.js');
const { draft } = await import('./folder-next.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync, mount, unmount } = await import('svelte');
const { default: OpenFolderNextHost } = await import(
	'./fixtures/OpenFolderNextHost.svelte'
);

const tables = { notes: Type.Object({ title: Type.String() }) };
const text = (title: string, body = 'Body\n') =>
	`---\ntitle: ${title}\n---\n${body}`;
async function setup(
	onFailed?: (failure: import('./folder-next.js').SaveFailure) => void,
) {
	const memory = memoryHost({
		'notes/milk.md': text('Milk'),
		'notes/eggs.md': text('Eggs'),
	});
	const folder = svelteFolder(
		expectOk(await createFolder(memory.storage, { tables, throttleMs: 0 })),
		{ onFailed },
	);
	return { folder, notes: folder.tables.notes, control: memory.control };
}

type Notes = SvelteTable<(typeof tables)['notes']>;
const titleOf = (row: ReturnType<Notes['row']>) =>
	row?.issues === null ? row.fields.title : '';

async function until(check: () => boolean) {
	for (let turn = 0; turn < 100 && !check(); turn++) {
		await Bun.sleep(2);
		flushSync();
	}
	expect(check()).toBe(true);
}

test('rows is tracked, and an effect reruns when a row lands', async () => {
	const { notes } = await setup();
	const titles = follow(() => notes.rows.map((note) => note.fields?.title));
	flushSync();
	expect(titles.values).toEqual([['Eggs', 'Milk']]);
	await notes.update('milk', { fields: { title: 'Oat milk' } });
	await until(() => titles.values.at(-1)?.[1] === 'Oat milk');
	expect(titles.values.at(-1)).toEqual(['Eggs', 'Oat milk']);
	titles.stop();
});

test('row(id) answers the same object until its own row changes', async () => {
	const { notes } = await setup();
	const eggs = follow(() => notes.row('eggs'));
	flushSync();
	await notes.update('milk', { fields: { title: 'Oat milk' } });
	await until(() => eggs.values.length >= 2);
	expect(eggs.values[1]).toBe(eggs.values[0]);
	expect(notes.row('eggs')).toBe(notes.rows[0]);
	eggs.stop();
});

test('a draft shows typing until its save lands, then follows the row', async () => {
	const { notes, control } = await setup();
	let open: () => void = () => {};
	control.putGate = new Promise((resolve) => {
		open = resolve;
	});
	const title = draft(
		() => titleOf(notes.row('milk')),
		(title) => notes.update('milk', { fields: { title } }),
	);
	title.text = 'Oat';
	expect(title.text).toBe('Oat');
	expect(notes.row('milk')?.fields?.title).toBe('Milk');
	open();
	control.putGate = undefined;
	await until(() => notes.row('milk')?.fields?.title === 'Oat');
	expect(title.text).toBe('Oat');
});

test('a draft whose save fails follows the disk again', async () => {
	const { notes, control } = await setup();
	control.failPut.set('notes/milk.md', {
		name: 'StorageFailed',
		message: 'disk full',
		cause: null,
	});
	const title = draft(
		() => titleOf(notes.row('milk')),
		(title) => notes.update('milk', { fields: { title } }),
	);
	title.text = 'Oat';
	await until(() => title.text === 'Milk');
});

test('onFailed receives the body of a failed update', async () => {
	const failures: import('./folder-next.js').SaveFailure[] = [];
	const { notes, control } = await setup((failure) => failures.push(failure));
	control.failPut.set('notes/milk.md', {
		name: 'StorageFailed',
		message: 'disk full',
		cause: null,
	});
	const saved = await notes.update('milk', { body: 'Keep this text' });
	expect(saved.error?.name).toBe('StorageFailed');
	await until(() => failures.length === 1);
	expect(failures[0]).toMatchObject({
		path: 'notes/milk.md',
		text: 'Keep this text',
	});
});

test('folder update reports typed text on failure', async () => {
	const failures: import('./folder-next.js').SaveFailure[] = [];
	const { folder, control } = await setup((failure) => failures.push(failure));
	control.failPut.set('notes/milk.md', {
		name: 'StorageFailed',
		message: 'disk full',
		cause: null,
	});
	const saved = await folder.update('notes/milk.md', { body: 'Folder body' });
	expect(saved.error?.name).toBe('StorageFailed');
	await until(() => failures.length === 1);
	expect(failures[0]).toMatchObject({
		path: 'notes/milk.md',
		text: 'Folder body',
	});
});

test('holdWindowClose false registers no desktop close listener', async () => {
	const memory = memoryHost();
	const folder = expectOk(await createFolder(memory.storage, { tables }));
	const target = document.createElement('div');
	document.body.append(target);
	desktop(true);
	try {
		const view = mount(OpenFolderNextHost, {
			target,
			props: {
				open: () => Promise.resolve({ data: folder, error: null }),
				holdWindowClose: false,
			},
		});
		await until(() => target.textContent?.includes('Ready') ?? false);
		expect(nativeWindow.listeners).toBe(0);
		await unmount(view);
		await until(() => memory.control.closed);
	} finally {
		nativeWindow.reset();
		target.remove();
	}
});

test('custom class applies to loading and refusal screens', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	let refuse: (
		result: Awaited<import('@epicenter/folder/next').Opened<typeof tables>>,
	) => void = () => {};
	const opening = new Promise<
		Awaited<import('@epicenter/folder/next').Opened<typeof tables>>
	>((resolve) => {
		refuse = resolve;
	});
	const view = mount(OpenFolderNextHost, {
		target,
		props: {
			open: () => opening,
			class: 'settings-height',
			holdWindowClose: false,
		},
	});
	flushSync();
	expect(target.querySelector('.settings-height')).not.toBeNull();
	refuse({
		data: null,
		error: { name: 'Unavailable', message: 'offline', cause: null },
	});
	await until(() => target.textContent?.includes('offline') ?? false);
	expect(target.querySelector('.settings-height')).not.toBeNull();
	await unmount(view);
	target.remove();
});

test('a create that finds the file there answers the caller and is not reported', async () => {
	const failures: import('./folder-next.js').SaveFailure[] = [];
	const { notes } = await setup((failure) => failures.push(failure));
	const made = await notes.create('milk', { fields: { title: 'Milk again' } });
	expect(made.error?.name).toBe('Exists');
	await Bun.sleep(5);
	expect(failures).toEqual([]);
});
