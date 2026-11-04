/**
 * `fromClient`, the getter-shaped state for apps that open their own client:
 * a thin facade over the client read as a folder (`folderOf`) through
 * `reactive`. What a collection shows and how it writes and edits is the
 * folder's, tested in `@epicenter/folder` (`folder.writes.test.ts`,
 * `note-edit.test.ts`); this file tests the facade.
 *
 * Key behaviors:
 * - One client has one facade; another client of the same files has its own
 * - A collection's getters track while an effect reads them, and list only then
 * - An editor's reads are getters that track
 * - A write, or a keystroke in `edit`, is out for the page's leave guard at
 *   once, until it answers
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineContract } from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/node';
import { unwrap } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';

const { fromClient } = await import('./client.svelte.js');
const { guardLeave, whenSaved } = await import('./leave-guard.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync } = await import('svelte');

const todos = defineContract({
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
	},
});

// The page's leave guard, which every write through the facade holds.
guardLeave();

/** Whether leaving the page now would ask first: a write is out. */
function leavingAsks() {
	const leaving = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(leaving);
	return leaving.defaultPrevented;
}

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

/** A device client of a new temporary folder; `again()` opens another of the same files. */
async function device() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-svelte-client-'));
	folders.push(root);
	const open = async () => unwrap(await openDevice(todos, { path: root }));
	return { client: await open(), again: open };
}

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(check()).toBe(true);
}

test('one client has one facade; another client of the same files has its own', async () => {
	const { client, again } = await device();
	expect(fromClient(client)).toBe(fromClient(client));
	expect(fromClient(client).todos).not.toBe(fromClient(await again()).todos);
});

test('a collection’s getters track while an effect reads them', async () => {
	const { client, again } = await device();
	const files = fromClient(client);
	expect(files.todos.loading).toBe(true);
	const titles = follow(() => files.todos.items.map(({ title }) => title));
	await until(() => !files.todos.loading);
	expectOk(await (await again()).todos.create({ id: 'a', title: 'Milk', done: false }));
	await until(() => titles.values.at(-1)?.[0] === 'Milk');
	expect(files.todos.get({ id: 'a' })?.title).toBe('Milk');
	titles.stop();
});

test('an editor’s reads are getters that track', async () => {
	const { client } = await device();
	expectOk(await client.todos.create({ id: 'a', title: 'Milk', done: false }));
	const files = fromClient(client);
	const todo = files.todos.edit({ id: 'a' });
	const seen = follow(() => ({ exists: todo.exists, title: todo.fields.title }));
	await until(() => seen.values.at(-1)?.exists === true);
	todo.fields.title = 'Oat milk';
	flushSync();
	expect(seen.values.at(-1)?.title).toBe('Oat milk');
	expect(todo.typed).toEqual({ title: 'Oat milk' });
	expectOk(await todo.landed());
	expect(todo.error).toBeNull();
	seen.stop();
});

test('a write, or a keystroke in edit, is out for the leave guard at once until it answers', async () => {
	const { client } = await device();
	expectOk(await client.todos.create({ id: 'a', title: '', done: false }));
	const files = fromClient(client);

	const updating = files.todos.update({ id: 'a' }, { done: true });
	expect(leavingAsks()).toBe(true);
	expectOk(await updating);
	await whenSaved();
	expect(leavingAsks()).toBe(false);

	const todo = files.todos.edit({ id: 'a' });
	todo.fields.title = 'Oat milk';
	expect(todo.saving).toBe(true);
	expect(leavingAsks()).toBe(true);
	expectOk(await todo.landed());
	await whenSaved();
	expect(leavingAsks()).toBe(false);
});
