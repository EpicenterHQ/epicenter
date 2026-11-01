/**
 * `fromClient` and its note editor (`edit`) over a real device client in a temporary
 * directory: what an app shows of a contract's files, and how its editors
 * write them.
 *
 * Key behaviors:
 * - One client has one adapter, so every component composing from it shows
 *   the same state
 * - A collection lists and subscribes only while an effect reads it
 * - Changes heard through `subscribe` reach readers; a listing a change
 *   interrupted never replaces a newer one
 * - A listing that fails is tried again while someone reads, so a passing
 *   storage failure does not leave the list frozen
 * - A write through the adapter shows at once, without waiting for a listing
 * - `update` carries an edit over another writer's other fields, and after a
 *   clash shows theirs, so saving again applies over it
 * - Invalid notes are shown with their text, and `replace` repairs one;
 *   a draft's `replace` over the version it began from refuses a change since
 * - `edit` sends one save at a time, the newest carrying every field typed
 *   since the last that landed, so typing never clashes with itself; another
 *   writer's change to a typed field surfaces and the typing stays
 * - `edit` shows the newest typing until its own save answers: an older
 *   answer, a discard, or teardown never brings back what was replaced
 * - `edit`'s `fields` are the contract's fields and the body, apart from
 *   its controls, and `exists` says whether a note that reads is listed
 * - A write through the adapter, or a keystroke in `edit`, is out for the
 *   leave guard at once, until it answers
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
	type NoteClient,
} from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/node';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

const { fromClient } = await import('./client.svelte.js');
const { isSaving, whenSaved } = await import('./leave-guard.js');
const { follow } = await import('./reactive.test-support.svelte.js');
const { flushSync, mount, unmount } = await import('svelte');
const { default: InitHost } = await import('./fixtures/InitHost.svelte');

const todos = defineContract({
	name: 'todos',
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
	const root = await mkdtemp(join(tmpdir(), 'epicenter-svelte-client-'));
	folders.push(root);
	return {
		root,
		/** A client of the folder, as another tab or program would hold. */
		open: async () => unwrap(await openDevice(todos, { path: root })),
		text: (path: string) => readFile(join(root, path), 'utf8'),
	};
}

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(check()).toBe(true);
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

/** Mount a component whose setup calls `make`, and return what it made. */
function setup<T>(make: () => T) {
	const target = document.createElement('div');
	document.body.append(target);
	let made: T | undefined;
	const view = mount(InitHost, {
		target,
		props: { make, expose: (value: unknown) => (made = value as T) },
	});
	flushSync();
	return {
		made: made as T,
		async unmount() {
			await unmount(view);
			target.remove();
		},
	};
}

test('a collection lists and subscribes only while an effect reads it, and follows changes', async () => {
	const { open } = await folder();
	const device = await open();
	const { client, counts } = counted(device);
	const files = fromClient(client);

	expect(files.todos.items).toEqual([]);
	expect(files.todos.loading).toBe(true);
	expect(counts).toEqual({ lists: 0, subscribed: 0 });

	const titles = follow(() => files.todos.items.map(({ title }) => title));
	await until(() => !files.todos.loading);
	expect(counts).toEqual({ lists: 1, subscribed: 1 });
	expect(titles.values.at(-1)).toEqual([]);

	expectOk(await device.todos.create({ id: 'a', title: 'Milk', done: false }));
	await until(() => titles.values.at(-1)?.[0] === 'Milk');

	titles.stop();
	// The subscription is released in a microtask after the last reader goes.
	await Bun.sleep(0);
	expect(counts.subscribed).toBe(0);
});

test('a listing that fails is tried again while someone reads, with no change to prompt it', async () => {
	const { open } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: 'Milk', done: false }));
	let failing = 1;
	let lists = 0;
	const files = fromClient({
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
		titles: files.todos.items.map(({ title }) => title),
		error: files.todos.error?.name ?? null,
	});

	const shown = follow(read);
	await until(() => shown.values.at(-1)?.error === 'Unavailable');
	expect(shown.values.at(-1)?.titles).toEqual([]);
	await until(() => shown.values.at(-1)?.titles[0] === 'Milk');
	expect(shown.values.at(-1)?.error).toBeNull();
	expect(lists).toBe(2);
	shown.stop();
	await Bun.sleep(0);

	// Nobody reads: a failing listing is not tried again.
	failing = Number.POSITIVE_INFINITY;
	const again = follow(read);
	await until(() => again.values.at(-1)?.error === 'Unavailable');
	again.stop();
	await Bun.sleep(0);
	const after = lists;
	await Bun.sleep(1200);
	expect(lists).toBe(after);
});

test('a write through the adapter shows at once, before any listing', async () => {
	const { open } = await folder();
	const { client, hold } = counted(await open());
	const files = fromClient(client);
	const shown = follow(() => files.todos.get({ id: 'a' })?.title);
	await until(() => !files.todos.loading);
	const release = hold();

	expectOk(await files.todos.create({ id: 'a', title: 'Milk', done: false }));
	flushSync();
	expect(shown.values.at(-1)).toBe('Milk');
	expectOk(await files.todos.update({ id: 'a' }, { title: 'Oat milk' }));
	flushSync();
	expect(shown.values.at(-1)).toBe('Oat milk');
	expectOk(await files.todos.delete({ id: 'a' }));
	flushSync();
	expect(shown.values.at(-1)).toBeUndefined();

	release();
	shown.stop();
});

test('a listing a change interrupted never replaces a newer one', async () => {
	const { open } = await folder();
	const device = await open();
	const { client, hold } = counted(device);
	const files = fromClient(client);
	const shown = follow(() => files.todos.get({ id: 'a' })?.title);
	await until(() => !files.todos.loading);

	// A change arrives, and its listing is read but held...
	const release = hold();
	expectOk(await device.todos.create({ id: 'b', title: 'Bread', done: false }));
	await Bun.sleep(20);
	// ...while a write lands that the held listing does not have.
	expectOk(await files.todos.create({ id: 'a', title: 'Milk', done: false }));
	flushSync();
	release();
	await until(() => files.todos.items.length === 2);
	expect(shown.values.slice(shown.values.indexOf('Milk'))).not.toContain(
		undefined,
	);
	shown.stop();
});

test('one client has one adapter; another client of the same files has its own', async () => {
	const { open } = await folder();
	const client = await open();
	expect(fromClient(client)).toBe(fromClient(client));
	expect(fromClient(client).todos).not.toBe(fromClient(await open()).todos);
});

test('update carries an edit over another writer’s other field; after a clash it shows theirs and saves over it', async () => {
	const { open, text } = await folder();
	const files = fromClient(await open());
	const other = await open();
	const shown = follow(() => files.todos.get({ id: 'a' }));
	await until(() => !files.todos.loading);
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
	flushSync();
	expect(shown.values.at(-1)?.title).toBe('Soy milk');
	expectOk(await files.todos.update({ id: 'a' }, { title: 'Rice milk' }));
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Rice milk\ndone: true\n---\n',
	);
	shown.stop();
});

test('an invalid note shows with its text, and replace repairs it at once', async () => {
	const { open, root } = await folder();
	const files = fromClient(await open());
	const broken = '---\ntitle: [unclosed\n---\nKept.\n';
	await Bun.write(join(root, 'todos/a.md'), broken);
	const invalid = follow(() =>
		files.todos.invalid.map(({ id, text }) => ({ id, text })),
	);
	await until(() => invalid.values.at(-1)?.length === 1);
	expect(invalid.values.at(-1)).toEqual([{ id: 'a', text: broken }]);

	const repaired = expectOk(
		await files.todos.replace(
			{ id: 'a' },
			'---\ntitle: Fixed\ndone: false\n---\nKept.\n',
		),
	);
	flushSync();
	expect(invalid.values.at(-1)).toEqual([]);
	expect(files.todos.get({ id: 'a' })).toEqual(repaired);
	invalid.stop();
});

test('replace over the version a draft began from refuses another writer’s change since, then shows theirs', async () => {
	const { open, root, text } = await folder();
	const files = fromClient(await open());
	await Bun.write(
		join(root, 'todos/a.md'),
		'---\ntitle: Milk\ndone: false\n---\n',
	);
	const shown = follow(() => files.todos.get({ id: 'a' })?.title);
	await until(() => shown.values.at(-1) === 'Milk');
	const began = files.todos.get({ id: 'a' })?.version;

	// Another writer changes it while the draft is open, and the adapter hears it.
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

test('a write through the adapter is saving at once until it answers', async () => {
	const { open } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: '', done: false }));
	const files = fromClient(device);
	const shown = follow(() => files.todos.get({ id: 'a' }));
	await until(() => shown.values.at(-1) !== undefined);

	const updating = files.todos.update({ id: 'a' }, { done: true });
	expect(isSaving()).toBe(true);
	expectOk(await updating);
	await whenSaved();
	expect(isSaving()).toBe(false);
	shown.stop();
});

// ============================================================================
// edit: one note as an immediate editor
// ============================================================================

/** `device`'s todos as `fromClient` shows them, with each `update` counted and held until `gate.open` settles. */
function gated(device: Client<Todos>) {
	const gate = { open: Promise.resolve(), updates: 0 };
	const files = fromClient({
		...device,
		todos: {
			...device.todos,
			async update(...args: Parameters<TodoNotes['update']>) {
				gate.updates++;
				await gate.open;
				return device.todos.update(...args);
			},
		},
	} as Client<Todos>);
	return { files, gate };
}

test('edit sends one save at a time, the newest carrying every field typed since the last landed, so typing never clashes with itself', async () => {
	const { open, text } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: '', done: false }));
	const { files, gate } = gated(device);
	const shown = follow(() => files.todos.get({ id: 'a' }));
	await until(() => shown.values.at(-1) !== undefined);
	const host = setup(() => files.todos.edit({ id: 'a' }));
	const todo = host.made;

	const release = Promise.withResolvers<void>();
	gate.open = release.promise;
	todo.fields.title = 'Oat';
	await until(() => gate.updates === 1);
	// Typed while the first save is out: one save after it carries them all.
	for (const typed of ['Oat ', 'Oat m', 'Oat milk']) todo.fields.title = typed;
	todo.fields.body = 'Two.\n';
	todo.fields.done = true;
	expect(todo.fields.title).toBe('Oat milk');
	release.resolve();
	expectOk(await todo.landed());
	expect(todo.error).toBeNull();
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Oat milk\ndone: true\n---\nTwo.\n',
	);
	// Each save went over the one before it, without a clash to retry.
	expect(gate.updates).toBe(2);
	flushSync();
	expect(todo.typed).toBeNull();
	expect(todo.fields.title).toBe('Oat milk');

	await host.unmount();
	shown.stop();
});

test('a keystroke in edit is saving, and out for the leave guard, at once until it answers', async () => {
	const { open, text } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: '', done: false }));
	const files = fromClient(device);
	const shown = follow(() => files.todos.get({ id: 'a' }));
	await until(() => shown.values.at(-1) !== undefined);

	const host = setup(() => files.todos.edit({ id: 'a' }));
	const todo = host.made;
	expect(todo.saving).toBe(false);
	todo.fields.title = 'Oat milk';
	expect(todo.saving).toBe(true);
	expect(isSaving()).toBe(true);
	expectOk(await todo.landed());
	await whenSaved();
	expect(todo.saving).toBe(false);
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Oat milk\ndone: false\n---\n',
	);

	await host.unmount();
	shown.stop();
});

test('edit carries typing over another writer’s change to other fields, and surfaces their change to a typed field, keeping the typing', async () => {
	const { open, text } = await folder();
	const device = await open();
	const other = await open();
	const created = expectOk(
		await device.todos.create({
			id: 'a',
			title: 'Milk',
			done: false,
			body: 'Two.\n',
		}),
	);
	const { files, gate } = gated(device);
	const shown = follow(() => files.todos.get({ id: 'a' }));
	await until(() => shown.values.at(-1) !== undefined);
	const host = setup(() => files.todos.edit({ id: 'a' }));
	const todo = host.made;

	// Another writer edits the body while the title's save is on its way.
	let release = Promise.withResolvers<void>();
	gate.open = release.promise;
	todo.fields.title = 'Oat milk';
	expectOk(
		await other.todos.update(
			{ id: 'a' },
			{ body: 'Three.\n' },
			{ over: created.version },
		),
	);
	release.resolve();
	expectOk(await todo.landed());
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Oat milk\ndone: false\n---\nThree.\n',
	);

	// Another writer edits the body while this editor's body save is on its way.
	await until(() => shown.values.at(-1)?.body === 'Three.\n');
	const before = expectOk(await other.todos.get({ id: 'a' }));
	release = Promise.withResolvers<void>();
	gate.open = release.promise;
	todo.fields.body = 'Four.\n';
	expectOk(
		await other.todos.update(
			{ id: 'a' },
			{ body: 'Five.\n' },
			{ over: before.version },
		),
	);
	release.resolve();
	const clash = await todo.landed();
	expect(clash.error?.name).toBe('Conflict');
	expect(todo.error?.name).toBe('Conflict');
	expect(todo.fields.body).toBe('Four.\n');
	expect(await text('todos/a.md')).toContain('Five.\n');

	// Saving again, having been told, applies over theirs.
	gate.open = Promise.resolve();
	todo.retry();
	expectOk(await todo.landed());
	expect(await text('todos/a.md')).toContain('Four.\n');

	await host.unmount();
	shown.stop();
});

test('a field typed while another field’s save is out still surfaces another writer’s change to it since its typing began', async () => {
	const { open, text } = await folder();
	const device = await open();
	const other = await open();
	const created = expectOk(
		await device.todos.create({
			id: 'a',
			title: 'Milk',
			done: false,
			body: 'Two.\n',
		}),
	);
	const { files, gate } = gated(device);
	const shown = follow(() => files.todos.get({ id: 'a' }));
	await until(() => shown.values.at(-1) !== undefined);
	const host = setup(() => files.todos.edit({ id: 'a' }));
	const todo = host.made;

	const release = Promise.withResolvers<void>();
	gate.open = release.promise;
	todo.fields.title = 'Oat milk';
	await until(() => gate.updates === 1);
	// The body's typing begins over 'Two.', then another writer changes it.
	todo.fields.body = 'Mine.\n';
	expectOk(
		await other.todos.update(
			{ id: 'a' },
			{ body: 'Theirs.\n' },
			{ over: created.version },
		),
	);
	release.resolve();
	const clash = await todo.landed();
	expect(clash.error?.name).toBe('Conflict');
	expect(todo.fields.body).toBe('Mine.\n');
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Oat milk\ndone: false\n---\nTheirs.\n',
	);

	await host.unmount();
	shown.stop();
});

test('edit shows the newest typing until its own save answers; discard shows the note, and teardown stops typing', async () => {
	const { open } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: 'Milk', done: false }));
	const gates: PromiseWithResolvers<void>[] = [];
	const files = fromClient({
		...device,
		todos: {
			...device.todos,
			async update(...args: Parameters<TodoNotes['update']>) {
				const gate = Promise.withResolvers<void>();
				gates.push(gate);
				await gate.promise;
				return device.todos.update(...args);
			},
		},
	} as Client<Todos>);
	const shown = follow(() => files.todos.get({ id: 'a' }));
	await until(() => shown.values.at(-1) !== undefined);
	const host = setup(() => files.todos.edit({ id: 'a' }));
	const todo = host.made;

	todo.fields.title = 'Oat';
	await until(() => gates.length === 1);
	todo.fields.title = 'Oat milk';
	// The older save lands; its answer does not replace the newer typing.
	gates[0]?.resolve();
	await until(() => gates.length === 2);
	expect(todo.fields.title).toBe('Oat milk');
	expect(todo.saving).toBe(true);

	// Discarding shows the note again; the save already out still lands.
	todo.discard();
	expect(todo.fields.title).toBe('Oat');
	gates[1]?.resolve();
	expectOk(await todo.landed());
	await until(() => !todo.saving);
	expect(todo.error).toBeNull();
	await until(() => todo.fields.title === 'Oat milk');

	// Once the component is gone, typing writes nothing.
	await host.unmount();
	todo.fields.title = 'Late';
	expectOk(await todo.landed());
	expect(gates).toHaveLength(2);
	shown.stop();
});

test('edit’s exists is whether a note that reads is listed at its path: not before the listing, nor once deleted, nor when it does not read', async () => {
	const { open, root } = await folder();
	const device = await open();
	await mkdir(join(root, 'todos'));
	// Written as another program would: macOS reports no deletion of a file
	// that was hard-linked, which is how this client creates one.
	await writeFile(
		join(root, 'todos/a.md'),
		'---\ntitle: Milk\ndone: false\n---\n',
	);
	await writeFile(join(root, 'todos/b.md'), '---\ntitle: [\n---\n');
	const files = fromClient(device);
	const host = setup(() => ({
		listed: files.todos.edit({ id: 'a' }),
		unread: files.todos.edit({ id: 'b' }),
	}));
	const { listed, unread } = host.made;
	expect(listed.exists).toBe(false);

	const seen = follow(() => ({ listed: listed.exists, unread: unread.exists }));
	await until(() => seen.values.at(-1)?.listed === true);
	expect(files.todos.invalid.map(({ id }) => id)).toEqual(['b']);
	expect(unread.exists).toBe(false);
	expect(unread.fields.title).toBeUndefined();

	// Another program deletes it: the editor says it is gone.
	const shown = expectOk(await device.todos.get({ id: 'a' }));
	expectOk(
		await (await open()).todos.delete({ id: 'a' }, { over: shown.version }),
	);
	await until(() => seen.values.at(-1)?.listed === false);
	expect(listed.fields.title).toBeUndefined();

	seen.stop();
	await host.unmount();
});

test('edit’s fields are the declared fields and the body, so a field named like a control is a field', async () => {
	const { open } = await folder();
	const files = fromClient(await open());
	const host = setup(() => files.todos.edit({ id: 'a' }));
	expect(Object.keys(host.made.fields)).toEqual(['title', 'done', 'body']);
	await host.unmount();

	const controls = defineContract({
		name: 'controls',
		collections: {
			notes: {
				path: 'notes/{id}.md',
				fields: {
					error: { type: 'string' },
					exists: { type: 'string' },
					note: { type: 'string' },
				},
			},
		},
	});
	const root = await mkdtemp(join(tmpdir(), 'epicenter-svelte-controls-'));
	folders.push(root);
	const device = unwrap(await openDevice(controls, { path: root }));
	expectOk(await device.notes.create({ id: 'a' }));
	const notes = fromClient(device).notes;
	expect(notes.fieldNames).toEqual(['error', 'exists', 'note']);
	const named = setup(() => notes.edit({ id: 'a' }));
	const edit = named.made;
	expect(Object.keys(edit.fields)).toEqual(['error', 'exists', 'note', 'body']);
	const seen = follow(() => edit.exists);
	await until(() => seen.values.at(-1) === true);

	edit.fields.error = 'Not an error';
	edit.fields.note = 'A field';
	expect(edit.fields.error).toBe('Not an error');
	expect(edit.error).toBeNull();
	expectOk(await edit.landed());
	expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe(
		'---\nerror: Not an error\nnote: A field\n---\n',
	);
	expect(edit.exists).toBe(true);
	expect(edit.fields.exists).toBeUndefined();

	seen.stop();
	await named.unmount();
});

test('edit with create makes the note on the first save, then updates it; one made elsewhere first is saved over', async () => {
	const { open, text } = await folder();
	const device = await open();
	let creates = 0;
	const files = fromClient({
		...device,
		todos: {
			...device.todos,
			create(...args: Parameters<TodoNotes['create']>) {
				creates++;
				return device.todos.create(...args);
			},
		},
	} as Client<Todos>);
	const shown = follow(() => files.todos.items);
	await until(() => !files.todos.loading);

	const create = () => ({ title: 'Draft', done: false });
	const host = setup(() => files.todos.edit({ id: 'a' }, { create }));
	const draft = host.made;
	for (const typed of ['H', 'Hi', 'Hi there']) draft.fields.body = typed;
	expectOk(await draft.landed());
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Draft\ndone: false\n---\nHi there',
	);
	expect(creates).toBe(1);
	draft.fields.body = 'Hi there!';
	expectOk(await draft.landed());
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Draft\ndone: false\n---\nHi there!',
	);
	expect(creates).toBe(1);
	await host.unmount();

	// Another program made `b` before this page heard of it: the save lands over theirs.
	expectOk(
		await (await open()).todos.create({ id: 'b', title: 'Theirs', done: true }),
	);
	const late = setup(() => files.todos.edit({ id: 'b' }, { create }));
	late.made.fields.body = 'Mine';
	expectOk(await late.made.landed());
	expect(await text('todos/b.md')).toBe(
		'---\ntitle: Theirs\ndone: true\n---\nMine',
	);
	await late.unmount();
	shown.stop();
});

test('a file collection lists its entries without bytes, and writes over what it shows', async () => {
	const { open } = await folder();
	const files = fromClient(await open());
	const shown = follow(() => files.attachments.items);
	await until(() => !files.attachments.loading);
	const created = expectOk(
		await files.attachments.create({
			id: 'a',
			ext: 'png',
			bytes: new Uint8Array([1]),
		}),
	);
	flushSync();
	expect(shown.values.at(-1)).toEqual([created]);
	expect(files.attachments.get({ id: 'a', ext: 'png' })).toEqual(created);
	const updated = expectOk(
		await files.attachments.update(
			{ id: 'a', ext: 'png' },
			{ bytes: new Uint8Array([2]) },
		),
	);
	flushSync();
	expect(shown.values.at(-1)).toEqual([updated]);
	expectOk(await files.attachments.delete({ id: 'a', ext: 'png' }));
	flushSync();
	expect(shown.values.at(-1)).toEqual([]);
	shown.stop();
});

test('a write over a note the adapter has not listed reads it first', async () => {
	const { open, text, root } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: 'Milk', done: false }));
	const files = fromClient(device);
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
