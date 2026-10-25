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
const { toast } = await import('@epicenter/ui/sonner');
const { draft } = await import('./folder-next.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync, mount, unmount } = await import('svelte');
const { default: OpenFolderNextHost } = await import(
	'./fixtures/OpenFolderNextHost.svelte'
);

const tables = { notes: Type.Object({ title: Type.String() }) };
const text = (title: string, body = 'Body\n') =>
	`---\ntitle: ${title}\n---\n${body}`;
async function setup() {
	const memory = memoryHost({
		'notes/milk.md': text('Milk'),
		'notes/eggs.md': text('Eggs'),
	});
	const folder = svelteFolder(
		expectOk(await createFolder(memory.storage, { tables, throttleMs: 0 })),
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
	title.value = 'Oat';
	expect(title.value).toBe('Oat');
	expect(notes.row('milk')?.fields?.title).toBe('Milk');
	open();
	control.putGate = undefined;
	await until(() => notes.row('milk')?.fields?.title === 'Oat');
	expect(title.value).toBe('Oat');
});

test('a failed draft keeps its typed value and retries on a later edit', async () => {
	const { notes, control } = await setup();
	control.failPut.set('notes/milk.md', {
		name: 'StorageFailed',
		message: 'disk full',
		cause: null,
	});
	const title = draft(
		() => titleOf(notes.row('milk')),
		(value) => notes.update('milk', { fields: { title: value } }),
	);
	title.value = 'Oat';
	await until(() => title.error !== null);
	expect(title.value).toBe('Oat');
	expect(title.error?.message).toBe('disk full');
	control.failPut.clear();
	title.set('Soy');
	expect(title.error).toBeNull();
	await until(() => titleOf(notes.row('milk')) === 'Soy');
	expect(title.value).toBe('Soy');
});

test('retry saves typed input and discard follows the source', async () => {
	const { notes, control } = await setup();
	control.failPut.set('notes/milk.md', {
		name: 'StorageFailed',
		message: 'disk full',
		cause: null,
	});
	const title = draft(
		() => titleOf(notes.row('milk')),
		(value) => notes.update('milk', { fields: { title: value } }),
	);
	title.set('Oat');
	await until(() => title.error !== null);
	control.failPut.clear();
	title.retry();
	await until(() => titleOf(notes.row('milk')) === 'Oat');
	title.set('Discard me');
	title.discard();
	expect(title.value).toBe('Oat');
	expect(title.error).toBeNull();
});

test('an older save answer never clears newer typing', async () => {
	const first = Promise.withResolvers<{ data: null; error: null }>();
	const second = Promise.withResolvers<{ data: null; error: null }>();
	let calls = 0;
	const title = draft(
		() => 'Disk',
		() => (++calls === 1 ? first.promise : second.promise),
	);
	title.set('First');
	title.set('Second');
	first.resolve({ data: null, error: null });
	await Promise.resolve();
	expect(title.value).toBe('Second');
	second.resolve({ data: null, error: null });
	await Promise.resolve();
	expect(title.value).toBe('Disk');
});

test('settled passes through without relisting', async () => {
	const { folder } = await setup();
	await folder.settled('notes/milk.md');
	expect(folder.tables.notes.row('milk')).toBeDefined();
});

test('settled lands a body draft before a whole-file editor opens', async () => {
	const memory = memoryHost({ 'notes/milk.md': text('Milk') });
	const core = expectOk(
		await createFolder(memory.storage, { tables, throttleMs: 10_000 }),
	);
	const folder = svelteFolder(core);
	const body = draft(
		() => folder.tables.notes.row('milk')?.body ?? '',
		(value) => folder.tables.notes.update('milk', { body: value }),
	);
	let release: () => void = () => {};
	memory.control.putGate = new Promise((resolve) => {
		release = resolve;
	});
	body.set('Typed body');
	const ready = folder.settled('notes/milk.md');
	await until(() => memory.log.puts.length === 1);
	memory.control.putGate = undefined;
	release();
	await ready;
	const source = folder.file('notes/milk.md')?.data;
	expect(source).toContain('Typed body');
	expect(body.value).toBe('Typed body');
});

test('a remounted draft reads landed text after settled', async () => {
	const memory = memoryHost({ 'notes/milk.md': text('Milk') });
	const core = expectOk(
		await createFolder(memory.storage, { tables, throttleMs: 10_000 }),
	);
	const folder = svelteFolder(core);
	let release: () => void = () => {};
	memory.control.putGate = new Promise((resolve) => {
		release = resolve;
	});
	const first = draft(
		() => titleOf(folder.tables.notes.row('milk')),
		(value) => folder.tables.notes.update('milk', { fields: { title: value } }),
	);
	first.set('Remounted');
	const ready = folder.settled('notes/milk.md');
	await until(() => memory.log.puts.length === 1);
	memory.control.putGate = undefined;
	release();
	await ready;
	const remounted = draft(
		() => titleOf(folder.tables.notes.row('milk')),
		(value) => folder.tables.notes.update('milk', { fields: { title: value } }),
	);
	expect(remounted.value).toBe('Remounted');
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

test('OpenFolder keeps one toast per path across repeated failed sends', async () => {
	toast.dismiss();
	const memory = memoryHost({ 'notes/milk.md': text('Milk') });
	const folder = expectOk(
		await createFolder(memory.storage, { tables, throttleMs: 0 }),
	);
	memory.control.failPut.set('notes/milk.md', {
		name: 'StorageFailed',
		message: 'disk full',
		cause: null,
	});
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(OpenFolderNextHost, {
		target,
		props: {
			open: () => Promise.resolve({ data: folder, error: null }),
			holdWindowClose: false,
		},
	});
	await until(() => target.textContent?.includes('Ready') ?? false);
	await folder.tables.notes.update('milk', { body: 'First' });
	await until(() => toast.getActiveToasts().length === 1);
	const first = toast.getActiveToasts()[0]?.id;
	await folder.tables.notes.update('milk', { body: 'Second' });
	await until(() => toast.getActiveToasts()[0]?.id !== first);
	expect(toast.getActiveToasts()).toHaveLength(1);
	await unmount(view);
	target.remove();
	toast.dismiss();
});
