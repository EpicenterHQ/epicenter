/**
 * A folder's collection reads and writes: what an app shows of a
 * contract's files, and how one write (`set`, `delete`) makes it so
 * (ADR-0774, ADR-0775).
 *
 * Key behaviors:
 * - A collection lists and follows its files only while something listens,
 *   and a failing listing is tried again while someone listens
 * - A write shows once it lands, without waiting for a listing
 * - `set` gives a note the fields named and keeps the rest; named fields
 *   take this write; a body changed since it was shown merges by lines
 * - A write reads just before writing; when the file moved in between, it
 *   reads and applies the change again
 * - A value that does not fit the contract is written and shows as
 *   invalid; a change to a note whose front matter does not parse keeps
 *   the note and adds the change as a conflict block
 * - A name that would leave the collection throws before anything is
 *   written
 * - `delete` of a note gone is fine; one changed since shown is kept
 * - Writes land in order; one that cannot land waits, with `saving()` and
 *   `unavailable()` saying so, and lands when the store is back
 * - A file collection's `set` is the later write winning, and `append`
 *   works where the store can
 *
 * See also:
 * - `note-edit.test.ts` for the note editor
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineContract } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { memoryStore } from './device/memory-store.js';
import type { DeviceStore, Version } from './device/store.js';
import { createFolder } from './folder.js';
import { memory, memoryFiles } from './memory.js';
import { directory } from './node.js';
import { openFolder } from './open-folder.js';

const todos = defineContract({
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
		attachments: { path: 'todos/{id}.{ext}' },
	},
});

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

/** Listen through `subscribe`, recording what `read` answers now and after each change, until `stop`. */
function watch<T>(
	subscribe: (listener: () => void) => () => void,
	read: () => T,
) {
	const values = [read()];
	const stop = subscribe(() => values.push(read()));
	return { values, stop };
}

/** A folder in memory, and the world outside it. */
function inMemory() {
	const place = memory();
	const folder = openFolder(todos, place);
	return { folder, outside: memoryFiles(place), place };
}

/** A store in memory counting listings and live watches, with listings that can be held. */
function counted() {
	const store = memoryStore();
	const counts = { lists: 0, watching: 0 };
	let hold: Promise<void> | null = null;
	const wrapped: DeviceStore = {
		...store,
		async list(under) {
			counts.lists++;
			const listed = await store.list(under);
			if (hold) await hold;
			return listed;
		},
		watch(listener) {
			counts.watching++;
			const stop = store.watch(listener);
			return () => {
				counts.watching--;
				stop();
			};
		},
	};
	return {
		folder: createFolder(todos, async () => Ok(wrapped)),
		outside: store.outside,
		counts,
		/** Hold every listing from now on, already read, until the returned release. */
		hold() {
			const held = Promise.withResolvers<void>();
			hold = held.promise;
			return () => {
				hold = null;
				held.resolve();
			};
		},
	};
}

const note = (fields: string, body = '') => `---\n${fields}---\n${body}`;

test('a collection lists and follows its files only while something listens', async () => {
	const { folder, outside, counts } = counted();
	expect(folder.todos.items()).toEqual([]);
	expect(folder.todos.loading()).toBe(true);
	await Bun.sleep(5);
	expect(counts).toEqual({ lists: 0, watching: 0 });

	const titles = watch(folder.todos.subscribe, () =>
		folder.todos.items().map(({ title }) => title),
	);
	await until(() => !folder.todos.loading());
	expect(counts.watching).toBe(1);
	expect(titles.values.at(-1)).toEqual([]);

	await outside.write('todos/a.md', note('title: Milk\ndone: false\n'));
	await until(() => titles.values.at(-1)?.[0] === 'Milk');

	titles.stop();
	expect(counts.watching).toBe(0);
});

test('a listing that fails is tried again while someone listens, with no change to prompt it', async () => {
	const { folder, outside } = inMemory();
	await outside.write('todos/a.md', note('title: Milk\ndone: false\n'));
	const undo = outside.refuseReads('storage is busy');
	const shown = watch(folder.subscribe, () => folder.unavailable()?.name);
	const titles = watch(folder.todos.subscribe, () =>
		folder.todos.items().map(({ title }) => title),
	);
	await until(() => shown.values.at(-1) === 'Unavailable');
	expect(titles.values.at(-1)).toEqual([]);
	undo();
	await until(() => titles.values.at(-1)?.[0] === 'Milk');
	expect(folder.unavailable()).toBeNull();
	titles.stop();
	shown.stop();
});

test('a write shows once it lands, before any listing', async () => {
	const { folder, hold } = counted();
	const shown = watch(
		folder.todos.subscribe,
		() => folder.todos.get({ id: 'a' })?.title,
	);
	await until(() => !folder.todos.loading());
	const release = hold();

	await folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
	expect(shown.values.at(-1)).toBe('Milk');
	await folder.todos.set({ id: 'a' }, { title: 'Oat milk' });
	expect(shown.values.at(-1)).toBe('Oat milk');
	await folder.todos.delete({ id: 'a' });
	expect(shown.values.at(-1)).toBeUndefined();

	release();
	shown.stop();
});

test('set makes a note where none is, and changes only the fields it names', async () => {
	const { folder, outside } = inMemory();
	await folder.todos.set(
		{ id: 'a' },
		{ title: 'Milk', done: false, body: 'Two\n' },
	);
	expect(outside.read('todos/a.md')).toBe(
		note('title: Milk\ndone: false\n', 'Two\n'),
	);
	await folder.todos.set({ id: 'a' }, { done: true });
	expect(outside.read('todos/a.md')).toBe(
		note('title: Milk\ndone: true\n', 'Two\n'),
	);
	// Twice is once.
	await folder.todos.set({ id: 'a' }, { done: true });
	expect(outside.read('todos/a.md')).toBe(
		note('title: Milk\ndone: true\n', 'Two\n'),
	);
});

test('another writer’s change to another field stays; a field both changed takes this write', async () => {
	const { folder, outside } = inMemory();
	folder.todos.subscribe(() => {});
	await folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
	await outside.write('todos/a.md', note('title: Oat milk\ndone: true\n'));
	// The folder has not listed their change yet: this write is made over what it showed.
	await folder.todos.set({ id: 'a' }, { done: false });
	expect(outside.read('todos/a.md')).toBe(
		note('title: Oat milk\ndone: false\n'),
	);
});

test('a write that meets a change made after it read reads again and applies its change', async () => {
	const { folder, outside } = inMemory();
	await folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
	const release = outside.hold();
	const writing = folder.todos.set({ id: 'a' }, { done: true });
	await Bun.sleep(5);
	await outside.write(
		'todos/a.md',
		note('title: Bread\ndone: false\n', 'Theirs\n'),
	);
	release();
	await writing;
	expect(outside.read('todos/a.md')).toBe(
		note('title: Bread\ndone: true\n', 'Theirs\n'),
	);
});

test('a body changed since it was shown merges by lines, and a clash keeps both in a block', async () => {
	const { folder, outside } = inMemory();
	folder.todos.subscribe(() => {});
	const fields = 'title: Milk\ndone: false\n';
	await folder.todos.set(
		{ id: 'a' },
		{ title: 'Milk', done: false, body: 'one\ntwo\nthree\n' },
	);
	await outside.write('todos/a.md', note(fields, 'one\ntwo\nthree\nfour\n'));
	await folder.todos.set({ id: 'a' }, { body: 'zero\none\ntwo\nthree\n' });
	expect(outside.read('todos/a.md')).toBe(
		note(fields, 'zero\none\ntwo\nthree\nfour\n'),
	);

	await until(
		() => folder.todos.get({ id: 'a' })?.body.startsWith('zero') ?? false,
	);
	await outside.write(
		'todos/a.md',
		note(fields, 'zero\nONE\ntwo\nthree\nfour\n'),
	);
	await folder.todos.set(
		{ id: 'a' },
		{ body: 'zero\nuno\ntwo\nthree\nfour\n' },
	);
	const text = outside.read('todos/a.md') ?? '';
	expect(text).toContain('<<<<<<< current');
	expect(text).toContain('ONE');
	expect(text).toContain('uno');
});

test('writes queued one after another never clash with each other', async () => {
	const { folder, outside } = inMemory();
	folder.todos.subscribe(() => {});
	const first = folder.todos.set(
		{ id: 'a' },
		{ title: 'Milk', done: false, body: 'one\n' },
	);
	const second = folder.todos.set({ id: 'a' }, { body: 'two\n' });
	const third = folder.todos.set({ id: 'a' }, { body: 'three\n' });
	await Promise.all([first, second, third]);
	expect(outside.read('todos/a.md')).toBe(
		note('title: Milk\ndone: false\n', 'three\n'),
	);
	const made = folder.todos.set({ id: 'b' }, { title: 'Eggs', done: false });
	const gone = folder.todos.delete({ id: 'b' });
	await Promise.all([made, gone]);
	expect(outside.read('todos/b.md')).toBeNull();
});

test('a value that does not fit the contract is written, and shows as invalid', async () => {
	const { folder, outside } = inMemory();
	folder.todos.subscribe(() => {});
	await folder.todos.set({ id: 'a' }, { title: 5 as never });
	expect(outside.read('todos/a.md')).toBe(note('title: 5\n'));
	await until(() => folder.todos.invalid().length === 1);
	expect(folder.todos.invalid()[0]).toMatchObject({
		id: 'a',
		text: note('title: 5\n'),
	});
	// A set of the fields that fit repairs it.
	await folder.todos.set({ id: 'a' }, { title: 'Five', done: false });
	expect(folder.todos.invalid()).toEqual([]);
	expect(folder.todos.get({ id: 'a' })?.title).toBe('Five');
});

test('a change to a note whose front matter does not parse keeps it, and adds the change as a block', async () => {
	const { folder, outside } = inMemory();
	await outside.write('todos/a.md', note('title: [\n', 'Kept\n'));
	await folder.todos.set({ id: 'a' }, { done: true });
	const text = outside.read('todos/a.md') ?? '';
	expect(text.startsWith(note('title: [\n', 'Kept\n'))).toBe(true);
	expect(text).toContain('done: true');
	expect(text).toContain('<<<<<<< current');
});

test('a name that would leave the collection throws before anything is written', async () => {
	const { folder, outside } = inMemory();
	for (const id of ['', 'a/b', '..', '.hidden', 'a:b', 'a?b', 'a|b', 'a\nb'])
		expect(() =>
			folder.todos.set({ id }, { title: 'x', done: false }),
		).toThrow();
	expect(() => folder.todos.delete({ id: '../x' })).toThrow();
	expect(() =>
		folder.attachments.set({ id: 'a', ext: 'b/c' }, new Uint8Array()),
	).toThrow();
	expect(() =>
		folder.todos.set({ id: 'a' }, { title: (() => {}) as never }),
	).toThrow();
	expect(folder.saving()).toBe(false);
	expect(outside.paths()).toEqual([]);
	expect(folder.todos.get({ id: 'a/b' })).toBeUndefined();
});

test('delete: one already gone is gone, one changed since shown is kept, and one never shown is removed', async () => {
	const { folder, outside } = inMemory();
	await folder.todos.delete({ id: 'none' });
	await outside.write('todos/a.md', note('title: Milk\ndone: false\n'));
	await folder.todos.delete({ id: 'a' });
	expect(outside.read('todos/a.md')).toBeNull();

	folder.todos.subscribe(() => {});
	await folder.todos.set({ id: 'b' }, { title: 'Eggs', done: false });
	await outside.write('todos/b.md', note('title: Eggs\ndone: true\n'));
	await folder.todos.delete({ id: 'b' });
	expect(outside.read('todos/b.md')).toBe(note('title: Eggs\ndone: true\n'));
	expect(folder.todos.get({ id: 'b' })?.done).toBe(true);
});

test('a write that cannot land waits, in order, saying why, and lands when the store is back', async () => {
	const { folder, outside } = inMemory();
	const saving = watch(folder.subscribe, () => folder.saving());
	const undo = outside.refuse('disk full');
	let landed = 0;
	const first = folder.todos
		.set({ id: 'a' }, { title: 'One', done: false })
		.then(() => landed++);
	const second = folder.todos
		.set({ id: 'a' }, { title: 'Two' })
		.then(() => landed++);
	await until(() => folder.unavailable()?.name === 'Unavailable');
	expect(folder.unavailable()).toMatchObject({ cause: 'disk full' });
	expect(folder.saving()).toBe(true);
	expect(landed).toBe(0);
	undo();
	await Promise.all([first, second]);
	expect(outside.read('todos/a.md')).toBe(note('title: Two\ndone: false\n'));
	expect(folder.unavailable()).toBeNull();
	expect(folder.saving()).toBe(false);
	expect(saving.values.at(0)).toBe(false);
	expect(saving.values.at(-1)).toBe(false);
	saving.stop();
});

test('a write is saving on the folder from its call until it lands', async () => {
	const { folder } = inMemory();
	const saving = watch(folder.subscribe, () => folder.saving());
	const writing = folder.todos.set({ id: 'a' }, { title: '', done: false });
	expect(folder.saving()).toBe(true);
	await writing;
	expect(folder.saving()).toBe(false);
	expect(
		saving.values.filter((value, index, all) => value !== all[index - 1]),
	).toEqual([false, true, false]);
	saving.stop();
});

test('a file collection lists entries without bytes; set is the later write, and delete keeps a change since shown', async () => {
	const { folder, outside } = inMemory();
	const shown = watch(folder.attachments.subscribe, () =>
		folder.attachments.items(),
	);
	await until(() => !folder.attachments.loading());
	const at = { id: 'a', ext: 'png' };
	await folder.attachments.set(at, new Uint8Array([1]));
	expect(shown.values.at(-1)).toEqual([at]);
	await outside.write('todos/a.png', new Uint8Array([9]));
	await folder.attachments.set(at, new Uint8Array([2]));
	expect(expectOk(await folder.attachments.read(at))?.bytes).toEqual(
		new Uint8Array([2]),
	);
	await outside.write('todos/a.png', new Uint8Array([3]));
	await folder.attachments.delete(at);
	expect(expectOk(await folder.attachments.read(at))?.bytes).toEqual(
		new Uint8Array([3]),
	);
	await until(() => shown.values.at(-1)?.length === 1);
	await folder.attachments.delete(at);
	expect(shown.values.at(-1)).toEqual([]);
	shown.stop();
});

test('over a directory, a write over a note the folder has not listed reads it first', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-folder-writes-'));
	folders.push(root);
	const folder = openFolder(todos, directory(root));
	await folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
	const other = openFolder(todos, directory(root));
	await other.todos.set({ id: 'a' }, { done: true });
	expect(await readFile(join(root, 'todos/a.md'), 'utf8')).toBe(
		note('title: Milk\ndone: true\n'),
	);
	await writeFile(join(root, 'todos/b.md'), note('title: [\n'));
	await other.todos.set({ id: 'b' }, { title: 'B', done: false });
	expect(await readFile(join(root, 'todos/b.md'), 'utf8')).toContain(
		'<<<<<<< current',
	);
});

test('a file collection appends where its store can, and its listeners hear an announced append', async () => {
	const held = new Map<string, Uint8Array>();
	const store: DeviceStore = {
		list: async () =>
			Ok(
				[...held].map(([path, bytes]) => ({
					path,
					stamp: `${path}:${bytes.length}`,
				})),
			),
		async read(path) {
			const bytes = held.get(path);
			if (bytes === undefined) return Ok(null);
			const stamp = `${path}:${bytes.length}`;
			return Ok({ bytes, version: stamp as Version, stamp });
		},
		write: async () => Ok({ landed: null }),
		async append(path, added, { create }) {
			const there = held.get(path);
			if (create === (there !== undefined)) return Ok('stale');
			held.set(path, new Uint8Array([...(there ?? []), ...added]));
			return Ok('landed');
		},
		watch: () => () => {},
	};
	const folder = createFolder(todos, async () => Ok(store));
	let heard = 0;
	const stop = folder.attachments.subscribe(() => heard++);
	const at = { id: 'a', ext: 'm4a' };
	const piece = (create: boolean, announce = false) =>
		folder.attachments.append(at, new Uint8Array([1]), { create, announce });

	expect(expectOk(await piece(true))).toBe(true);
	expect(expectOk(await piece(true))).toBe(false);
	expect(expectOk(await piece(false))).toBe(true);
	expect(expectOk(await piece(false))).toBe(true);
	await Bun.sleep(20);
	const heardBefore = heard;
	expectOk(await piece(false, true));
	await until(() => heard > heardBefore);
	expect(held.get('todos/a.m4a')).toEqual(new Uint8Array([1, 1, 1, 1]));
	expect(
		expectOk(
			await folder.attachments.append(
				{ id: 'b', ext: 'm4a' },
				new Uint8Array([2]),
				{
					create: false,
					announce: true,
				},
			),
		),
	).toBe(false);
	stop();
});

test('a file collection over a store that cannot append answers Unavailable', async () => {
	const { folder } = inMemory();
	const appended = await folder.attachments.append(
		{ id: 'a', ext: 'm4a' },
		new Uint8Array([1]),
		{ create: true, announce: false },
	);
	expect(appended.error?.name).toBe('Unavailable');
});
