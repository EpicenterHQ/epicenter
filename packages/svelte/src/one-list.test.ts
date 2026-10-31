/**
 * `oneList` over real device clients in temporary directories: one stands
 * for this device, a second for the person's repository.
 *
 * Key behaviors:
 * - A note on both sides shows the device copy (mid-upload); notes sort by
 *   placeholders unless the app gives an order
 * - Signed out, a new note stays on the device, recorded in the outbox
 * - Signed in, a new note goes to the repository; offline, it stays on the
 *   device to upload later; created on the device (`createOn`), it always
 *   stays there to upload
 * - Edits, deletes and repairs go to the copy shown, and one that meets the
 *   device copy gone follows the note to the repository
 * - A note the device lets go of stays shown until the repository lists
 *   again; one deleted here does not
 * - A note that does not read shows with its text and is repaired with
 *   `replace`
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Client,
	ClientError,
	defineContract,
} from '@epicenter/definition/contract';
import { openDevice, outboxOf } from '@epicenter/folder/node';
import { expectErr, expectOk } from 'wellcrafted/testing';

const { fromClient, oneList } = await import('./client.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync } = await import('svelte');

const todos = defineContract({
	name: 'todos',
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
	},
});
type Todos = typeof todos;

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

/** A directory of todos and a device client over it. */
async function side(files: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-one-list-'));
	folders.push(root);
	for (const [path, text] of Object.entries(files)) await put(root, path, text);
	return {
		root,
		client: openDevice(todos, { path: root }),
		text: (path: string) =>
			readFile(join(root, path), 'utf8').catch(() => null),
	};
}

/** Write a file the way another program would: no client hears it. */
async function put(root: string, path: string, text: string) {
	await mkdir(join(root, path, '..'), { recursive: true });
	await writeFile(join(root, path), text);
}

async function until(check: () => boolean) {
	for (let turn = 0; turn < 400 && !check(); turn++) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(check()).toBe(true);
}

/** The list over a device and, unless null, a repository, with the device's outbox. */
function listOver(
	device: Client<Todos>,
	repository: Client<Todos> | null,
	{
		order,
		createOn,
	}: Pick<
		Parameters<typeof oneList<Todos, 'todos'>>[2],
		'order' | 'createOn'
	> = {},
) {
	return oneList(todos, 'todos', {
		device: fromClient(device).todos,
		repository: repository && fromClient(repository).todos,
		outbox: outboxOf(device),
		order,
		createOn,
	});
}

/** Read `list` in an effect, as a view does, until both sides have listed. */
async function shown(list: ReturnType<typeof listOver>) {
	const rows = follow(() => ({
		items: list.items.map(
			({ id, title }) => `${list.where({ id })}:${id}:${title}`,
		),
		invalid: list.invalid.map(({ id }) => `${list.where({ id })}:${id}`),
	}));
	await until(() => !list.loading);
	return {
		values: () => rows.values,
		latest: () => rows.values.at(-1),
		stop: rows.stop,
	};
}

const note = (title: string, done = false) =>
	`---\ntitle: ${title}\ndone: ${done}\n---\n`;

test('a note on both sides shows the device copy, in the order the app gives', async () => {
	const device = await side({
		'todos/b.md': note('B, edited before upload'),
		'todos/d.md': '---\ntitle: D\n---\n',
	});
	const repository = await side({
		'todos/a.md': note('A', true),
		'todos/b.md': note('B'),
		'todos/c.md': note('C'),
		'todos/d.md': note('D'),
	});
	const byKey = await shown(listOver(device.client, repository.client));
	expect(byKey.latest()).toEqual({
		items: [
			'repository:a:A',
			'device:b:B, edited before upload',
			'repository:c:C',
		],
		// The device's copy of `d` does not read; the repository's is hidden behind it.
		invalid: ['device:d'],
	});
	byKey.stop();

	const openFirst = await shown(
		listOver(device.client, repository.client, {
			order: (a, b) =>
				Number(a.done) - Number(b.done) || a.id.localeCompare(b.id),
		}),
	);
	expect(openFirst.latest()?.items).toEqual([
		'device:b:B, edited before upload',
		'repository:c:C',
		'repository:a:A',
	]);
	openFirst.stop();
});

test('the side a note shows from is kept outside its fields: its own `where` key stays its own', async () => {
	const device = await side({
		'todos/a.md': '---\ntitle: A\ndone: false\nwhere: home\n---\n',
		'todos/d.md': '---\ntitle: D\n---\n',
	});
	const repository = await side({ 'todos/b.md': note('B') });
	const list = listOver(device.client, repository.client);
	const view = await shown(list);

	expect(view.latest()).toEqual({
		items: ['device:a:A', 'repository:b:B'],
		invalid: ['device:d'],
	});
	expect((list.get({ id: 'a' }) as Record<string, unknown>).where).toBe('home');
	expect(Object.keys(list.get({ id: 'b' }) ?? {})).not.toContain('where');
	expect(list.where({ id: 'gone' })).toBeUndefined();

	expectOk(await list.update({ id: 'a' }, { done: true }));
	expect(await device.text('todos/a.md')).toBe(
		'---\ntitle: A\ndone: true\nwhere: home\n---\n',
	);
	view.stop();
});

test('signed out, a new note stays on this device, recorded in the outbox', async () => {
	const device = await side();
	const list = listOver(device.client, null);
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

test('signed in, a new note goes to the repository', async () => {
	const device = await side();
	const repository = await side();
	const list = listOver(device.client, repository.client);
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

test('created on the device, a new note stays there signed in, recorded in the outbox to upload', async () => {
	const device = await side();
	const repository = await side();
	const list = listOver(device.client, repository.client, {
		createOn: 'device',
	});
	const view = await shown(list);

	expectOk(await list.create({ id: 'milk', title: 'Milk', done: false }));
	await until(() => view.latest()?.items.includes('device:milk:Milk') ?? false);
	expect(await device.text('todos/milk.md')).toBe(note('Milk'));
	expect(await repository.text('todos/milk.md')).toBeNull();
	const captures = expectOk(await outboxOf(device.client).list()).items;
	expect(captures.map(({ paths }) => Object.keys(paths))).toEqual([
		['todos/milk.md'],
	]);
	view.stop();
});

test('signed in with the server unreachable, a new note stays on this device to upload later, and the list says why', async () => {
	const device = await side();
	const repository = await side();
	const offline = new Error('offline');
	const unreachable: Client<Todos> = {
		todos: {
			...repository.client.todos,
			list: async () => ClientError.Unavailable({ cause: offline }),
			create: async () => ClientError.Unavailable({ cause: offline }),
		},
	};
	const list = listOver(device.client, unreachable);
	const view = await shown(list);
	expect(list.error).toBeNull();
	expect(list.repositoryError?.name).toBe('Unavailable');

	expectOk(await list.create({ id: 'milk', title: 'Milk', done: false }));
	await until(() => view.latest()?.items.includes('device:milk:Milk') ?? false);
	expect(await device.text('todos/milk.md')).toBe(note('Milk'));
	expect(expectOk(await outboxOf(device.client).list()).items).toHaveLength(1);
	view.stop();
});

test('edits and deletes go to the copy shown: the device copy while there is one, then the repository copy', async () => {
	const device = await side({ 'todos/milk.md': note('Milk here') });
	const repository = await side({ 'todos/milk.md': note('Milk') });
	const list = listOver(device.client, repository.client);
	const view = await shown(list);
	expect(view.latest()?.items).toEqual(['device:milk:Milk here']);

	expectOk(await list.update({ id: 'milk' }, { done: true }));
	expect(await device.text('todos/milk.md')).toBe(note('Milk here', true));
	expect(await repository.text('todos/milk.md')).toBe(note('Milk'));

	// Deleted here: the repository's copy shows at once, never the deleted one.
	expectOk(await list.delete({ id: 'milk' }));
	await until(() => view.latest()?.items.join() === 'repository:milk:Milk');
	expect(await device.text('todos/milk.md')).toBeNull();

	expectOk(await list.update({ id: 'milk' }, { title: 'Oat milk' }));
	expect(await repository.text('todos/milk.md')).toBe(note('Oat milk'));
	view.stop();
});

test('a note moving from the device to the repository never leaves the list', async () => {
	const device = await side({ 'todos/milk.md': note('Milk') });
	const repository = await side();
	const list = listOver(device.client, repository.client);
	const view = await shown(list);
	expect(view.latest()?.items).toEqual(['device:milk:Milk']);
	const from = view.values().length;

	// The upload lands through the wire, unheard by the repository side...
	await put(repository.root, 'todos/milk.md', note('Milk'));
	// ...and the device lets go of its copy.
	const held = expectOk(await device.client.todos.get({ id: 'milk' }));
	expectOk(
		await device.client.todos.delete({ id: 'milk' }, { over: held.version }),
	);
	await Bun.sleep(50);
	flushSync();
	expect(view.latest()?.items).toEqual(['repository:milk:Milk']);
	// The repository's next listing shows its own copy.
	expectOk(
		await repository.client.todos.create({
			id: 'oat',
			title: 'Oat',
			done: false,
		}),
	);
	await until(
		() =>
			view.latest()?.items.join() === 'repository:milk:Milk,repository:oat:Oat',
	);
	for (const value of view.values().slice(from))
		expect(value.items.some((row) => row.endsWith(':milk:Milk'))).toBe(true);
	view.stop();
});

test('an edit or a delete racing the device letting go follows the note to the repository', async () => {
	const device = await side({
		'todos/milk.md': note('Milk'),
		'todos/oat.md': note('Oat'),
	});
	const repository = await side({
		'todos/milk.md': note('Milk'),
		'todos/oat.md': note('Oat'),
	});
	const list = listOver(device.client, repository.client);
	const view = await shown(list);
	expect(view.latest()?.items).toEqual(['device:milk:Milk', 'device:oat:Oat']);

	// The uploader lets go of the device copies; the list has not heard yet.
	const uploader = openDevice(todos, { path: device.root });
	for (const id of ['milk', 'oat']) {
		const held = expectOk(await uploader.todos.get({ id }));
		expectOk(await uploader.todos.delete({ id }, { over: held.version }));
	}

	expectOk(await list.update({ id: 'milk' }, { title: 'Oat milk' }));
	expect(await repository.text('todos/milk.md')).toBe(note('Oat milk'));
	expectOk(await list.delete({ id: 'oat' }));
	expect(await repository.text('todos/oat.md')).toBeNull();
	await until(() => view.latest()?.items.join() === 'repository:milk:Oat milk');
	view.stop();
});

test('a note that does not read shows with its text and is repaired with replace', async () => {
	const broken = '---\ntitle: [Milk\n---\nOat, not dairy\n';
	const device = await side();
	const repository = await side({ 'todos/milk.md': broken });
	const list = listOver(device.client, repository.client);
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
