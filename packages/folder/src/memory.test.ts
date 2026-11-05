/**
 * `memory()` and `memoryFiles`: a place in memory and the world outside it.
 *
 * Key behaviors:
 * - A file another program writes is heard and listed, and one that does
 *   not read is listed as invalid with its text; another program reads what
 *   the folder wrote
 * - A held write keeps the folder `saving()` until released, then lands
 * - A refused write waits with `unavailable()` saying why, and a refused
 *   read answers `Unavailable`, below its directory alone, until undone
 * - An open held or refused waits or fails until released or undone; one
 *   refused as `Unavailable` keeps opening
 * - Of two writes over nothing at once, one lands and the other applies over it
 * - Two folders at one place share its files and hear each other's writes
 * - Any other folder throws
 */
import { expect, test } from 'bun:test';
import { ClientError, defineContract } from '@epicenter/definition/contract';
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
	for (let turn = 0; turn < 2000 && !check(); turn++) await Bun.sleep(1);
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
	const set = folder.todos.set({ id: 'a' }, { title: 'Milk' });
	await Bun.sleep(5);
	expect(folder.saving()).toBe(true);
	release();
	await set;
	expect(folder.saving()).toBe(false);
});

test('a refused write waits, saying why, and lands once the refusal is undone', async () => {
	const folder = openFolder(todos, memory());
	const undo = memoryFiles(folder).refuse('disk full');
	const set = folder.todos.set({ id: 'a' }, { title: 'Milk' });
	await until(() => folder.unavailable() !== null);
	expect(folder.unavailable()).toMatchObject({
		name: 'Unavailable',
		cause: 'disk full',
	});
	undo();
	await set;
	expect(memoryFiles(folder).read('todos/a.md')).toBe(
		'---\ntitle: Milk\n---\n',
	);
});

test('a refusal below a directory refuses only there, and refused reads answer Unavailable while writes land', async () => {
	const folder = openFolder(todos, memory());
	const undo = memoryFiles(folder).refuse('read-only', { under: 'todos' });
	const waiting = folder.todos.set({ id: 'a' }, { title: 'Milk' });
	await until(() => folder.unavailable() !== null);
	undo();
	await waiting;
	await folder.notes.set({ id: 'n' }, {});

	const unread = memoryFiles(folder).refuseReads('offline', { under: 'todos' });
	await memoryFiles(folder).write('todos/b.md', '---\ntitle: Bread\n---\n');
	await until(() => folder.unavailable()?.name === 'Unavailable');
	await memoryFiles(folder).write('notes/m.md', '---\n---\n');
	await until(() => folder.notes.items().length === 2);
	expect(folder.todos.items()).toHaveLength(1);
	unread();
	await until(() => folder.todos.items().length === 2);
	expect(memoryFiles(folder).read('todos/a.md')).toBe(
		'---\ntitle: Milk\n---\n',
	);
	expect(memoryFiles(folder).paths()).toEqual([
		'notes/m.md',
		'notes/n.md',
		'todos/a.md',
		'todos/b.md',
	]);
	expect(memoryFiles(folder).paths('notes')).toEqual([
		'notes/m.md',
		'notes/n.md',
	]);
});

test('an open held waits, and one refused fails until undone and retried', async () => {
	const place = memory();
	const release = memoryFiles(place).holdOpen();
	const undo = memoryFiles(place).refuseOpen(
		OpenFolderError.StorageUnavailable({ cause: 'no private storage' }).error,
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

test('an open refused as Unavailable keeps opening, saying why, and opens once undone', async () => {
	const place = memory();
	const undo = memoryFiles(place).refuseOpen(
		ClientError.Unavailable({ cause: 'offline' }).error,
	);
	const folder = openFolder(todos, place);
	await until(() => folder.unavailable() !== null);
	expect(folder.state().status).toBe('opening');
	undo();
	for (let turn = 0; turn < 200 && folder.state().status !== 'open'; turn++)
		await Bun.sleep(10);
	expect(folder.state().status).toBe('open');
	expect(folder.unavailable()).toBeNull();
});

test('of two writes over nothing at once, one lands and the other applies over it', async () => {
	const place = memory();
	const folder = openFolder(todos, place);
	const other = openFolder(todos, place);
	await Promise.all([
		folder.todos.set({ id: 'a' }, { title: 'A', body: 'one\n' }),
		other.todos.set({ id: 'a' }, { title: 'B' }),
	]);
	const text = memoryFiles(folder).read('todos/a.md') ?? '';
	expect(text).toContain('one\n');
	expect(['---\ntitle: A\n---\none\n', '---\ntitle: B\n---\none\n']).toContain(
		text,
	);
});

test('two folders at one place share its files and hear each other', async () => {
	const place = memory();
	const one = openFolder(todos, place);
	const two = openFolder(todos, place);
	const stop = two.todos.subscribe(() => {});
	await one.todos.set({ id: 'a' }, { title: 'Milk' });
	await until(() => two.todos.items().length === 1);
	stop();
});

test('a folder not opened in memory throws', () => {
	const elsewhere = createFolder(todos, async () => {
		throw new Error('never opened');
	});
	expect(() => memoryFiles(elsewhere)).toThrow();
});
