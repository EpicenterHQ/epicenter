/**
 * A folder's collection reads and writes over a real device client in a
 * temporary directory (`createFolder` over it): what an app shows of a contract's files,
 * and how its writes land in what it shows. Moved here from the Svelte
 * adapter's tests once the work moved into the folder.
 *
 * Key behaviors:
 * - A collection lists and follows its files only while something listens
 * - Changes heard through `subscribe` reach readers; a listing a change
 *   interrupted never replaces a newer one
 * - A listing that fails is tried again while someone listens, so a passing
 *   storage failure does not leave the list frozen
 * - A write shows at once, without waiting for a listing; a create refused
 *   as `Occupied` shows what is there instead, and answers `Unavailable`
 *   when what is there cannot be read
 * - `update` carries an edit over another writer's other fields, and after a
 *   clash shows theirs, so saving again applies over it
 * - Invalid notes are shown with their text, and `replace` repairs one;
 *   a draft's `replace` over the version it began from refuses a change since
 * - A write is `saving()` on the folder from its call until it answers
 * - A file collection appends where its store can, heard when the file is
 *   made and announced; elsewhere `append` is `Unavailable`
 *
 * See also:
 * - `note-edit.test.ts` for the note editor
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Client,
	ClientError,
	type Contract,
	defineContract,
	type NoteClient,
} from '@epicenter/definition/contract';
import { Ok, unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createDeviceClient } from './device/client.js';
import type { DeviceStore } from './device/store.js';
import { createFolder } from './folder.js';
import { openDevice } from './node.js';

/** `client`, already open, as a folder of `contract`. */
const over = <TContract extends Contract>(
	contract: TContract,
	client: Client<TContract>,
) => createFolder(contract, async () => Ok(client));

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
type Todos = typeof todos;
type TodoNotes = NoteClient<Todos['collections']['todos']>;

const folders: string[] = [];
afterEach(async () => {
	await Promise.all(
		folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function folder() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-folder-writes-'));
	folders.push(root);
	return {
		root,
		/** A client of the folder, as another tab or program would hold. */
		open: async () => unwrap(await openDevice(todos, { path: root })),
		text: (path: string) => readFile(join(root, path), 'utf8'),
	};
}

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

/** `client`'s todos, counting listings and live subscriptions, with listings that can be held. */
function counted(client: Client<Todos>) {
	const counts = { lists: 0, subscribed: 0 };
	let hold: Promise<void> | null = null;
	const todos: TodoNotes = {
		...client.todos,
		async list() {
			counts.lists++;
			const listed = await client.todos.list();
			if (hold) await hold;
			return listed;
		},
		subscribe(listener) {
			counts.subscribed++;
			const stop = client.todos.subscribe(listener);
			return () => {
				counts.subscribed--;
				stop();
			};
		},
	};
	return {
		client: { ...client, todos } as Client<Todos>,
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

test('a collection lists and follows its files only while something listens', async () => {
	const { open } = await folder();
	const device = await open();
	const { client, counts } = counted(device);
	const files = over(todos, client);

	expect(files.todos.items()).toEqual([]);
	expect(files.todos.loading()).toBe(true);
	await Bun.sleep(5);
	expect(counts).toEqual({ lists: 0, subscribed: 0 });

	const titles = watch(files.todos.subscribe, () =>
		files.todos.items().map(({ title }) => title),
	);
	await until(() => !files.todos.loading());
	expect(counts.subscribed).toBe(1);
	expect(counts.lists).toBeGreaterThanOrEqual(1);
	expect(titles.values.at(-1)).toEqual([]);

	expectOk(await device.todos.create({ id: 'a', title: 'Milk', done: false }));
	await until(() => titles.values.at(-1)?.[0] === 'Milk');

	titles.stop();
	expect(counts.subscribed).toBe(0);
});

test('a listing that fails is tried again while someone listens, with no change to prompt it', async () => {
	const { open } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: 'Milk', done: false }));
	let failing = 1;
	let lists = 0;
	const files = over(todos, {
		...device,
		todos: {
			...device.todos,
			async list() {
				lists++;
				if (failing <= 0) return device.todos.list();
				failing--;
				return ClientError.Unavailable({ cause: 'storage is busy' });
			},
			// No change is ever heard: only a retry can list again.
			subscribe: () => () => {},
		},
	} as Client<Todos>);
	const read = () => ({
		titles: files.todos.items().map(({ title }) => title),
		error: files.todos.error()?.name ?? null,
	});

	const shown = watch(files.todos.subscribe, read);
	await until(() => shown.values.at(-1)?.error === 'Unavailable');
	expect(shown.values.at(-1)?.titles).toEqual([]);
	await until(() => shown.values.at(-1)?.titles[0] === 'Milk');
	expect(shown.values.at(-1)?.error).toBeNull();
	expect(lists).toBe(2);
	shown.stop();

	// Nobody listens: a failing listing is not tried again.
	failing = Number.POSITIVE_INFINITY;
	const again = watch(files.todos.subscribe, read);
	await until(() => again.values.at(-1)?.error === 'Unavailable');
	again.stop();
	const after = lists;
	await Bun.sleep(1200);
	expect(lists).toBe(after);
});

test('a write shows at once, before any listing', async () => {
	const { open } = await folder();
	const { client, hold } = counted(await open());
	const files = over(todos, client);
	const shown = watch(
		files.todos.subscribe,
		() => files.todos.get({ id: 'a' })?.title,
	);
	await until(() => !files.todos.loading());
	const release = hold();

	expectOk(await files.todos.create({ id: 'a', title: 'Milk', done: false }));
	expect(shown.values.at(-1)).toBe('Milk');
	expectOk(await files.todos.update({ id: 'a' }, { title: 'Oat milk' }));
	expect(shown.values.at(-1)).toBe('Oat milk');
	expectOk(await files.todos.delete({ id: 'a' }));
	expect(shown.values.at(-1)).toBeUndefined();

	release();
	shown.stop();
});

test('a create refused as Occupied shows what is there, before it answers', async () => {
	const { open } = await folder();
	const elsewhere = await open();
	const files = over(todos, await open());
	expectOk(
		await elsewhere.todos.create({ id: 'a', title: 'Theirs', done: false }),
	);
	const refused = expectErr(
		await files.todos.create({ id: 'a', title: 'Mine', done: false }),
	);
	expect(refused.name).toBe('Occupied');
	expect(files.todos.get({ id: 'a' })?.title).toBe('Theirs');
	expect(files.todos.items()).toHaveLength(1);
});

test('a refusal the folder cannot read again answers Unavailable, not the refusal', async () => {
	const { open } = await folder();
	const device = await open();
	const files = over(todos, {
		...device,
		todos: {
			...device.todos,
			create: async () => ClientError.Occupied({ path: 'todos/a.md' }),
			get: async () => ClientError.Unavailable({ cause: 'offline' }),
		},
	} as Client<Todos>);
	const refused = expectErr(
		await files.todos.create({ id: 'a', title: 'Mine', done: false }),
	);
	expect(refused).toMatchObject({ name: 'Unavailable', cause: 'offline' });
	expect(files.todos.get({ id: 'a' })).toBeUndefined();
});

test('a listing a change interrupted never replaces a newer one', async () => {
	const { open } = await folder();
	const device = await open();
	const { client, hold } = counted(device);
	const files = over(todos, client);
	const shown = watch(
		files.todos.subscribe,
		() => files.todos.get({ id: 'a' })?.title,
	);
	await until(() => !files.todos.loading());

	// A change arrives, and its listing is read but held...
	const release = hold();
	expectOk(await device.todos.create({ id: 'b', title: 'Bread', done: false }));
	await Bun.sleep(20);
	// ...while a write lands that the held listing does not have.
	expectOk(await files.todos.create({ id: 'a', title: 'Milk', done: false }));
	release();
	await until(() => files.todos.items().length === 2);
	expect(shown.values.slice(shown.values.indexOf('Milk'))).not.toContain(
		undefined,
	);
	shown.stop();
});

test('update carries an edit over another writer’s other field; after a clash it shows theirs and saves over it', async () => {
	const { open, text } = await folder();
	const files = over(todos, await open());
	const other = await open();
	const shown = watch(files.todos.subscribe, () =>
		files.todos.get({ id: 'a' }),
	);
	await until(() => !files.todos.loading());
	const created = expectOk(
		await files.todos.create({ id: 'a', title: 'Milk', done: false }),
	);

	expectOk(
		await other.todos.update(
			{ id: 'a' },
			{ done: true },
			{ over: created.version },
		),
	);
	// Shown before the change is heard: the edit is made over `created`.
	expectOk(
		await files.todos.update(
			{ id: 'a' },
			{ title: 'Oat milk' },
			{ base: created },
		),
	);
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Oat milk\ndone: true\n---\n',
	);

	const now = expectOk(await other.todos.get({ id: 'a' }));
	expectOk(
		await other.todos.update(
			{ id: 'a' },
			{ title: 'Soy milk' },
			{ over: now.version },
		),
	);
	const clash = expectErr(
		await files.todos.update(
			{ id: 'a' },
			{ title: 'Rice milk' },
			{ base: now },
		),
	);
	expect(clash.name).toBe('Conflict');
	expect(shown.values.at(-1)?.title).toBe('Soy milk');
	expectOk(await files.todos.update({ id: 'a' }, { title: 'Rice milk' }));
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Rice milk\ndone: true\n---\n',
	);
	shown.stop();
});

test('an invalid note shows with its text, and replace repairs it at once', async () => {
	const { open, root } = await folder();
	const files = over(todos, await open());
	const broken = '---\ntitle: [unclosed\n---\nKept.\n';
	await Bun.write(join(root, 'todos/a.md'), broken);
	const invalid = watch(files.todos.subscribe, () =>
		files.todos.invalid().map(({ id, text }) => ({ id, text })),
	);
	await until(() => invalid.values.at(-1)?.length === 1);
	expect(invalid.values.at(-1)).toEqual([{ id: 'a', text: broken }]);

	const repaired = expectOk(
		await files.todos.replace(
			{ id: 'a' },
			'---\ntitle: Fixed\ndone: false\n---\nKept.\n',
		),
	);
	expect(invalid.values.at(-1)).toEqual([]);
	expect(files.todos.get({ id: 'a' })).toEqual(repaired);
	invalid.stop();
});

test('replace over the version a draft began from refuses another writer’s change since, then shows theirs', async () => {
	const { open, root, text } = await folder();
	const files = over(todos, await open());
	await Bun.write(
		join(root, 'todos/a.md'),
		'---\ntitle: Milk\ndone: false\n---\n',
	);
	const shown = watch(
		files.todos.subscribe,
		() => files.todos.get({ id: 'a' })?.title,
	);
	await until(() => shown.values.at(-1) === 'Milk');
	const began = files.todos.get({ id: 'a' })?.version;

	// Another writer changes it while the draft is open, and the folder hears it.
	await Bun.write(
		join(root, 'todos/a.md'),
		'---\ntitle: Oat milk\ndone: false\n---\n',
	);
	await until(() => shown.values.at(-1) === 'Oat milk');

	const draft = '---\ntitle: Soy milk\ndone: false\n---\n';
	const refused = expectErr(
		await files.todos.replace({ id: 'a' }, draft, { over: began }),
	);
	expect(refused.name).toBe('Conflict');
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Oat milk\ndone: false\n---\n',
	);
	// Saving again over what is shown now replaces theirs, on purpose.
	expectOk(await files.todos.replace({ id: 'a' }, draft));
	expect(await text('todos/a.md')).toBe(draft);
	shown.stop();
});

test('a write is saving on the folder from its call until it answers, and the folder hears both', async () => {
	const { open } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: '', done: false }));
	const files = over(todos, device);
	await until(() => files.state().status === 'open');
	const saving = watch(files.subscribe, () => files.saving());

	const updating = files.todos.update({ id: 'a' }, { done: true });
	expect(files.saving()).toBe(true);
	expectOk(await updating);
	expect(files.saving()).toBe(false);
	expect(saving.values).toEqual([false, true, false]);
	saving.stop();
});

test('a file collection lists its entries without bytes, and writes over what it shows', async () => {
	const { open } = await folder();
	const files = over(todos, await open());
	const shown = watch(files.attachments.subscribe, () =>
		files.attachments.items(),
	);
	await until(() => !files.attachments.loading());
	const created = expectOk(
		await files.attachments.create({
			id: 'a',
			ext: 'png',
			bytes: new Uint8Array([1]),
		}),
	);
	expect(shown.values.at(-1)).toEqual([created]);
	expect(files.attachments.get({ id: 'a', ext: 'png' })).toEqual(created);
	const updated = expectOk(
		await files.attachments.update(
			{ id: 'a', ext: 'png' },
			{ bytes: new Uint8Array([2]) },
		),
	);
	expect(shown.values.at(-1)).toEqual([updated]);
	expectOk(await files.attachments.delete({ id: 'a', ext: 'png' }));
	expect(shown.values.at(-1)).toEqual([]);
	shown.stop();
});

test('a write over a note the folder has not listed reads it first', async () => {
	const { open, text, root } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: 'Milk', done: false }));
	const files = over(todos, device);
	expectOk(await files.todos.update({ id: 'a' }, { done: true }));
	expect(await text('todos/a.md')).toBe('---\ntitle: Milk\ndone: true\n---\n');
	expect(expectErr(await files.todos.delete({ id: 'none' })).name).toBe(
		'NotFound',
	);
	await writeFile(join(root, 'todos/b.md'), '---\ntitle: [\n---\n');
	expectOk(
		await files.todos.replace({ id: 'b' }, '---\ntitle: B\ndone: false\n---\n'),
	);
});

test('a file collection appends where its store can, and its listeners hear an announced append', async () => {
	const held = new Map<string, Uint8Array>();
	const store: DeviceStore = {
		list: async () =>
			Ok([...held.keys()].map((path) => ({ path, stamp: path }))),
		read: async () => Ok(null),
		write: async () => Ok({ landed: null }),
		async append(path, added, { create }) {
			const there = held.get(path);
			if (create === (there !== undefined)) return Ok('stale');
			held.set(path, new Uint8Array([...(there ?? []), ...added]));
			return Ok('landed');
		},
		watch: () => () => {},
	};
	const files = over(todos, createDeviceClient(todos, store));
	let heard = 0;
	const stop = files.attachments.subscribe(() => heard++);
	const at = { id: 'a', ext: 'm4a' };
	const piece = (create: boolean, announce = false) =>
		files.attachments.append(at, new Uint8Array([1]), { create, announce });

	expectOk(await piece(true));
	expect(expectErr(await piece(true)).name).toBe('Occupied');
	expectOk(await piece(false));
	expectOk(await piece(false));
	await Bun.sleep(20);
	const heardBefore = heard;
	expectOk(await piece(false, true));
	await until(() => heard > heardBefore);
	expect(held.get('todos/a.m4a')).toEqual(new Uint8Array([1, 1, 1, 1]));
	expect(
		expectErr(
			await files.attachments.append(
				{ id: 'b', ext: 'm4a' },
				new Uint8Array([2]),
				{ create: false, announce: true },
			),
		).name,
	).toBe('NotFound');
	stop();
});

test('a file collection over a store that cannot append answers Unavailable', async () => {
	const { open } = await folder();
	const files = over(todos, await open());
	expect(
		expectErr(
			await files.attachments.append(
				{ id: 'a', ext: 'm4a' },
				new Uint8Array([1]),
				{ create: true, announce: false },
			),
		).name,
	).toBe('Unavailable');
});
