/**
 * `memory()` and `memoryFiles`: a place in memory and the world outside it.
 *
 * Key behaviors:
 * - A file another program writes is heard and listed, and one that does
 *   not read is listed as invalid with its text; another program reads what
 *   the folder wrote
 * - A held write keeps the folder `saving()` until released, then lands
 * - A refused write or read answers `Unavailable` with the reason, below
 *   its directory alone, until undone
 * - An open held or refused waits or fails until released or undone
 * - Of two writes over one expectation at once, exactly one lands
 * - Two folders at one place share its files and hear each other's writes
 * - Any other folder throws
 */
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { OpenFolderError } from './errors.js';
import { createFolder } from './folder.js';
import { memory, memoryFiles } from './memory.js';
import { openFolder } from './open-folder.js';

const todos = defineContract({
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' } },
			required: ['title'],
		},
		notes: { path: 'notes/{id}.md' },
	},
});

async function until(check: () => boolean) {
	for (let turn = 0; turn < 200 && !check(); turn++) await Bun.sleep(1);
	expect(check()).toBe(true);
}

test('a file another program writes is heard, and one that does not read is listed with its text', async () => {
	const folder = openFolder(todos, memory());
	const stop = folder.todos.subscribe(() => {});
	await memoryFiles(folder).write('todos/a.md', '---\ntitle: Milk\n---\n');
	await until(() => folder.todos.items().length === 1);
	expect(folder.todos.get({ id: 'a' })?.title).toBe('Milk');

	await memoryFiles(folder).write('todos/b.md', '---\ntitle: [\n---\n');
	await until(() => folder.todos.invalid().length === 1);
	expect(folder.todos.invalid()[0]).toMatchObject({ id: 'b' });
	stop();
});

test('a held write keeps the folder saving until released, then lands', async () => {
	const folder = openFolder(todos, memory());
	const release = memoryFiles(folder).hold();
	const created = folder.todos.create({ id: 'a', title: 'Milk' });
	await Bun.sleep(5);
	expect(folder.saving()).toBe(true);
	release();
	expectOk(await created);
	expect(folder.saving()).toBe(false);
});

test('a refused write answers Unavailable with the reason, until undone', async () => {
	const folder = openFolder(todos, memory());
	const undo = memoryFiles(folder).refuse('disk full');
	const refused = expectErr(
		await folder.todos.create({ id: 'a', title: 'Milk' }),
	);
	expect(refused.name).toBe('Unavailable');
	undo();
	expectOk(await folder.todos.create({ id: 'a', title: 'Milk' }));
});

test('a refusal below a directory refuses only there, and refused reads answer Unavailable while writes land', async () => {
	const folder = openFolder(todos, memory());
	const undo = memoryFiles(folder).refuse('read-only', { under: 'todos' });
	expect(
		expectErr(await folder.todos.create({ id: 'a', title: 'Milk' })).name,
	).toBe('Unavailable');
	expectOk(await folder.notes.create({ id: 'n' }));
	undo();
	expectOk(await folder.todos.create({ id: 'a', title: 'Milk' }));

	const unread = memoryFiles(folder).refuseReads('offline', { under: 'todos' });
	expect(expectErr(await folder.todos.list()).name).toBe('Unavailable');
	expect(expectOk(await folder.notes.list()).items).toHaveLength(1);
	unread();
	expect(expectOk(await folder.todos.list()).items).toHaveLength(1);
	expect(memoryFiles(folder).read('todos/a.md')).toBe(
		'---\ntitle: Milk\n---\n',
	);
	expect(memoryFiles(folder).paths()).toEqual(['notes/n.md', 'todos/a.md']);
	expect(memoryFiles(folder).paths('notes')).toEqual(['notes/n.md']);
});

test('an open held waits, and one refused fails until undone and retried', async () => {
	const place = memory();
	const release = memoryFiles(place).holdOpen();
	const undo = memoryFiles(place).refuseOpen(
		OpenFolderError.StorageUnavailable({ cause: 'offline' }).error,
	);
	const folder = openFolder(todos, place);
	await Bun.sleep(5);
	expect(folder.state().status).toBe('opening');
	release();
	await until(() => folder.state().status === 'failed');
	const failed = folder.state();
	if (failed.status !== 'failed') throw new Error('expected a failed open');
	expect(failed.error.name).toBe('StorageUnavailable');
	undo();
	await failed.retry();
	expect(folder.state().status).toBe('open');
});

test('of two creates of one path at once, one lands and the other is Occupied', async () => {
	const folder = openFolder(todos, memory());
	const both = await Promise.all(
		['A', 'B'].map((title) => folder.todos.create({ id: 'a', title })),
	);
	expect(both.map(({ error }) => error?.name ?? 'landed').sort()).toEqual([
		'Occupied',
		'landed',
	]);
});

test('two folders at one place share its files and hear each other', async () => {
	const place = memory();
	const one = openFolder(todos, place);
	const two = openFolder(todos, place);
	const stop = two.todos.subscribe(() => {});
	expectOk(await one.todos.create({ id: 'a', title: 'Milk' }));
	await until(() => two.todos.items().length === 1);
	stop();
});

test('a folder not opened in memory throws', () => {
	const elsewhere = createFolder(todos, async () => {
		throw new Error('never opened');
	});
	expect(() => memoryFiles(elsewhere)).toThrow();
});
