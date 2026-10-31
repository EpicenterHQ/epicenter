/**
 * The one list Todos shows (decision 12): the todos still on this device
 * and the ones in the repository, by id, over real device clients in
 * temporary directories (a second one stands in for the repository).
 *
 * Key behaviors:
 * - A todo on both sides shows the device's copy (mid-upload); open todos
 *   come first, each oldest first
 * - Signed out, a new todo stays on the device, queued to upload
 * - Signed in, a new todo goes to the repository; offline, it stays on the
 *   device to upload later
 * - Edits, deletes and repairs go to the copy shown
 * - A note that does not read as a todo shows with its text and is repaired
 *   with `replace`
 *
 * Run with `--conditions=browser` (`bun run test`): `fromClient` needs
 * Svelte's client runtime.
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Client,
	ClientError,
	type Version,
} from '@epicenter/definition/contract';
import { openDevice, outboxOf } from '@epicenter/folder/node';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type Todos, todos } from './contract.js';

const { fromClient } = await import('@epicenter/svelte/client');
const { follow } = await import(
	'../../../../packages/svelte/src/reactive.test-support.svelte.js'
);
const { flushSync } = await import('svelte');
const { createTodoList, mergeTodos } = await import('./todos.js');

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

/** A directory of todos and a device client over it. */
async function side(files: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-todos-'));
	folders.push(root);
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), text);
	}
	return {
		client: openDevice(todos, { path: root }),
		text: (path: string) =>
			readFile(join(root, path), 'utf8').catch(() => null),
	};
}

async function until(check: () => boolean) {
	for (let turn = 0; turn < 400 && !check(); turn++) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(check()).toBe(true);
}

/** Read `list` in an effect, as the views do, until both sides have listed. */
async function shown(list: ReturnType<typeof createTodoList>) {
	const rows = follow(() => ({
		items: list.items.map(({ id, where, title }) => `${where}:${id}:${title}`),
		invalid: list.invalid.map(({ id, where }) => `${where}:${id}`),
	}));
	await until(() => !list.loading);
	return {
		latest: () => rows.values.at(-1),
		stop: rows.stop,
	};
}

const note = (title: string, done = false) =>
	`---\ntitle: ${title}\ndone: ${done}\n---\n`;

test('a todo on both sides shows the device copy, and open todos come first, each oldest first', () => {
	const todo = (id: string, title: string, done: boolean) => ({
		id,
		title,
		done,
		body: '',
		version: id as Version,
	});
	const merged = mergeTodos(
		{
			items: [todo('b', 'B, edited before upload', false)],
			invalid: [
				{
					id: 'd',
					path: 'todos/d.md',
					issues: [{ field: 'done', message: 'is required' }],
					text: '---\ntitle: D\n---\n',
					version: 'd' as Version,
				},
			],
		},
		{
			items: [
				todo('a', 'A', true),
				todo('b', 'B', false),
				todo('c', 'C', false),
				todo('d', 'D', false),
			],
			invalid: [],
		},
	);
	expect(
		merged.items.map(({ id, where, title }) => [id, where, title]),
	).toEqual([
		['b', 'device', 'B, edited before upload'],
		['c', 'repository', 'C'],
		['a', 'repository', 'A'],
	]);
	// The device's copy of `d` does not read; the repository's is hidden behind it.
	expect(merged.invalid.map(({ id, where }) => [id, where])).toEqual([
		['d', 'device'],
	]);
});

test('signed out, a new todo stays on this device, queued to upload', async () => {
	const device = await side();
	const list = createTodoList({
		device: fromClient(device.client).todos,
		repository: null,
		outbox: outboxOf(device.client),
	});
	const view = await shown(list);

	expectOk(await list.create({ id: 'milk', title: 'Milk', done: false }));
	await until(() => view.latest()?.items.includes('device:milk:Milk') ?? false);
	expect(await device.text('todos/milk.md')).toBe(note('Milk'));
	const captures = expectOk(await outboxOf(device.client).list()).items;
	expect(captures.map(({ paths }) => Object.keys(paths))).toEqual([
		['todos/milk.md'],
	]);
	view.stop();
});

test('signed in, a new todo goes to the repository', async () => {
	const device = await side();
	const repository = await side();
	const list = createTodoList({
		device: fromClient(device.client).todos,
		repository: fromClient(repository.client).todos,
		outbox: outboxOf(device.client),
	});
	const view = await shown(list);

	expectOk(await list.create({ id: 'milk', title: 'Milk', done: false }));
	await until(
		() => view.latest()?.items.includes('repository:milk:Milk') ?? false,
	);
	expect(await repository.text('todos/milk.md')).toBe(note('Milk'));
	expect(await device.text('todos/milk.md')).toBeNull();
	expect(expectOk(await outboxOf(device.client).list()).items).toEqual([]);
	view.stop();
});

test('signed in with the server unreachable, a new todo stays on this device to upload later', async () => {
	const device = await side();
	const repository = await side();
	const offline: Client<Todos> = {
		todos: {
			...repository.client.todos,
			create: async () =>
				ClientError.Unavailable({ cause: new Error('offline') }),
		},
	};
	const list = createTodoList({
		device: fromClient(device.client).todos,
		repository: fromClient(offline).todos,
		outbox: outboxOf(device.client),
	});
	const view = await shown(list);

	expectOk(await list.create({ id: 'milk', title: 'Milk', done: false }));
	await until(() => view.latest()?.items.includes('device:milk:Milk') ?? false);
	expect(await device.text('todos/milk.md')).toBe(note('Milk'));
	expect(expectOk(await outboxOf(device.client).list()).items).toHaveLength(1);
	view.stop();
});

test('edits and deletes go to the copy shown: the device copy while there is one, then the repository copy', async () => {
	const device = await side({ 'todos/milk.md': note('Milk here') });
	const repository = await side({ 'todos/milk.md': note('Milk') });
	const list = createTodoList({
		device: fromClient(device.client).todos,
		repository: fromClient(repository.client).todos,
		outbox: outboxOf(device.client),
	});
	const view = await shown(list);
	expect(view.latest()?.items).toEqual(['device:milk:Milk here']);

	expectOk(await list.update({ id: 'milk' }, { done: true }));
	expect(await device.text('todos/milk.md')).toBe(note('Milk here', true));
	expect(await repository.text('todos/milk.md')).toBe(note('Milk'));

	expectOk(await list.delete({ id: 'milk' }));
	await until(() => view.latest()?.items.join() === 'repository:milk:Milk');
	expect(await device.text('todos/milk.md')).toBeNull();

	expectOk(await list.update({ id: 'milk' }, { title: 'Oat milk' }));
	expect(await repository.text('todos/milk.md')).toBe(note('Oat milk'));
	view.stop();
});

test('a note that does not read as a todo shows with its text and is repaired with replace', async () => {
	const broken = '---\ntitle: [Milk\n---\nOat, not dairy\n';
	const device = await side();
	const repository = await side({ 'todos/milk.md': broken });
	const list = createTodoList({
		device: fromClient(device.client).todos,
		repository: fromClient(repository.client).todos,
		outbox: outboxOf(device.client),
	});
	const view = await shown(list);
	expect(view.latest()).toEqual({ items: [], invalid: ['repository:milk'] });
	const [invalid] = list.invalid;
	expect(invalid?.text).toBe(broken);
	expect(invalid?.path).toBe('todos/milk.md');

	// Text that still does not fit is refused, and nothing is written.
	const refused = expectErr(
		await list.replace({ id: 'milk' }, '---\ntitle: Milk\n---\nOat\n'),
	);
	expect(refused.name).toBe('Invalid');
	expect(await repository.text('todos/milk.md')).toBe(broken);

	expectOk(
		await list.replace(
			{ id: 'milk' },
			'---\ndone: false\ntitle: Milk\n---\nOat, not dairy\n',
		),
	);
	await until(() => view.latest()?.items.join() === 'repository:milk:Milk');
	expect(view.latest()?.invalid).toEqual([]);
	// Written in house style: the contract's fields in its order.
	expect(await repository.text('todos/milk.md')).toBe(
		`${note('Milk')}Oat, not dairy\n`,
	);
	view.stop();
});
