/**
 * `memoryFiles(folder)`: the world outside a folder in memory.
 *
 * Key behaviors:
 * - A file another program writes is heard and listed, and one that does
 *   not read is listed as invalid with its text
 * - A held write keeps the folder `saving()` until released, then lands
 * - A refused write answers `Unavailable` with the reason, until undone
 * - Any other folder throws
 */
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createFolder } from './folder.js';
import { memoryFiles } from './memory.js';
import { openFolder } from './open-folder.memory.js';

const todos = defineContract({
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' } },
			required: ['title'],
		},
	},
});

async function until(check: () => boolean) {
	for (let turn = 0; turn < 200 && !check(); turn++) await Bun.sleep(1);
	expect(check()).toBe(true);
}

test('a file another program writes is heard, and one that does not read is listed with its text', async () => {
	const folder = openFolder(todos);
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
	const folder = openFolder(todos);
	const release = memoryFiles(folder).hold();
	const created = folder.todos.create({ id: 'a', title: 'Milk' });
	await Bun.sleep(5);
	expect(folder.saving()).toBe(true);
	release();
	expectOk(await created);
	expect(folder.saving()).toBe(false);
});

test('a refused write answers Unavailable with the reason, until undone', async () => {
	const folder = openFolder(todos);
	const undo = memoryFiles(folder).refuse('disk full');
	const refused = expectErr(
		await folder.todos.create({ id: 'a', title: 'Milk' }),
	);
	expect(refused.name).toBe('Unavailable');
	undo();
	expectOk(await folder.todos.create({ id: 'a', title: 'Milk' }));
});

test('a folder not opened in memory throws', () => {
	const elsewhere = createFolder(todos, async () => {
		throw new Error('never opened');
	});
	expect(() => memoryFiles(elsewhere)).toThrow();
});
