/**
 * The note editor (`folder.todos.edit(args)`) over a real device client in
 * a temporary directory: one note as an immediate editor, with no framework.
 * Moved here from the Svelte adapter's tests once the editor moved into the
 * folder; the semantics are the same.
 *
 * Key behaviors:
 * - Saves go one at a time, the newest carrying every field typed since the
 *   last that landed, so typing never clashes with itself
 * - Another writer's change to other fields is carried over; their change
 *   to a typed field surfaces as a `Conflict` and the typing stays
 * - The editor shows the newest typing until its own save answers: an older
 *   answer or a discard never brings back what was replaced
 * - `fields` are the contract's fields and the body, apart from the
 *   controls, and `exists()` says whether a note that reads is listed
 * - A keystroke is `saving()`, on the editor and the folder, at once until
 *   it answers
 * - An editor nobody listens to holds nothing: no listing, no subscription
 *
 * See also:
 * - `folder.writes.test.ts` for the collection's own reads and writes
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Client,
	type Contract,
	defineContract,
	type NoteClient,
} from '@epicenter/definition/contract';
import { Ok, unwrap } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createFolder, type Folder } from './folder.js';
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
	const root = await mkdtemp(join(tmpdir(), 'epicenter-note-edit-'));
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

/** `device`'s todos as a folder, with each `update` counted and held until `gate.open` settles. */
function gated(device: Client<Todos>) {
	const gate = { open: Promise.resolve(), updates: 0 };
	const files = over(todos, {
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

/** Listen to the collection, as a reader would, until the note `a` is shown. */
async function listening(files: Folder<Todos>) {
	const stop = files.todos.subscribe(() => {});
	await until(() => files.todos.get({ id: 'a' }) !== undefined);
	return stop;
}

test('edit sends one save at a time, the newest carrying every field typed since the last landed, so typing never clashes with itself', async () => {
	const { open, text } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: '', done: false }));
	const { files, gate } = gated(device);
	const stop = await listening(files);
	const todo = files.todos.edit({ id: 'a' });

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
	expect(todo.error()).toBeNull();
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Oat milk\ndone: true\n---\nTwo.\n',
	);
	// Each save went over the one before it, without a clash to retry.
	expect(gate.updates).toBe(2);
	expect(todo.typed()).toBeNull();
	expect(todo.fields.title).toBe('Oat milk');
	stop();
});

test('a keystroke is saving, on the editor and the folder, at once until it answers', async () => {
	const { open, text } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: '', done: false }));
	const files = over(todos, device);
	const stop = await listening(files);
	const todo = files.todos.edit({ id: 'a' });
	let heard = 0;
	const stopHearing = todo.subscribe(() => heard++);

	expect(todo.saving()).toBe(false);
	todo.fields.title = 'Oat milk';
	expect(todo.saving()).toBe(true);
	expect(files.saving()).toBe(true);
	expect(heard).toBeGreaterThan(0);
	expectOk(await todo.landed());
	expect(todo.saving()).toBe(false);
	expect(files.saving()).toBe(false);
	expect(await text('todos/a.md')).toBe(
		'---\ntitle: Oat milk\ndone: false\n---\n',
	);
	stopHearing();
	stop();
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
	const stop = await listening(files);
	const todo = files.todos.edit({ id: 'a' });

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
	await until(() => files.todos.get({ id: 'a' })?.body === 'Three.\n');
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
	expect(todo.error()?.name).toBe('Conflict');
	expect(todo.fields.body).toBe('Four.\n');
	expect(await text('todos/a.md')).toContain('Five.\n');

	// Saving again, having been told, applies over theirs.
	gate.open = Promise.resolve();
	todo.retry();
	expectOk(await todo.landed());
	expect(await text('todos/a.md')).toContain('Four.\n');
	stop();
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
	const stop = await listening(files);
	const todo = files.todos.edit({ id: 'a' });

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
	stop();
});

test('edit shows the newest typing until its own save answers, and discard shows the note', async () => {
	const { open } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: 'Milk', done: false }));
	const gates: PromiseWithResolvers<void>[] = [];
	const files = over(todos, {
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
	const stop = await listening(files);
	const todo = files.todos.edit({ id: 'a' });

	todo.fields.title = 'Oat';
	await until(() => gates.length === 1);
	todo.fields.title = 'Oat milk';
	// The older save lands; its answer does not replace the newer typing.
	gates[0]?.resolve();
	await until(() => gates.length === 2);
	expect(todo.fields.title).toBe('Oat milk');
	expect(todo.saving()).toBe(true);

	// Discarding shows the note again; the save already out still lands.
	todo.discard();
	expect(todo.fields.title).toBe('Oat');
	gates[1]?.resolve();
	expectOk(await todo.landed());
	await until(() => !todo.saving());
	expect(todo.error()).toBeNull();
	await until(() => todo.fields.title === 'Oat milk');
	stop();
});

test('an editor nobody listens to holds nothing: the collection lists only while its editor is heard', async () => {
	const { open } = await folder();
	const device = await open();
	expectOk(await device.todos.create({ id: 'a', title: 'Milk', done: false }));
	let subscribed = 0;
	const files = over(todos, {
		...device,
		todos: {
			...device.todos,
			subscribe(listener: () => void) {
				subscribed++;
				const stop = device.todos.subscribe(listener);
				return () => {
					subscribed--;
					stop();
				};
			},
		},
	} as Client<Todos>);
	const todo = files.todos.edit({ id: 'a' });
	await Bun.sleep(5);
	expect(subscribed).toBe(0);
	expect(todo.exists()).toBe(false);

	const stop = todo.subscribe(() => {});
	await until(() => todo.exists());
	expect(subscribed).toBe(1);
	stop();
	expect(subscribed).toBe(0);
});

test('edit’s exists() is whether a note that reads is listed at its path: not before the listing, nor once deleted, nor when it does not read', async () => {
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
	const files = over(todos, device);
	const listed = files.todos.edit({ id: 'a' });
	const unread = files.todos.edit({ id: 'b' });
	expect(listed.exists()).toBe(false);

	const stop = listed.subscribe(() => {});
	await until(() => listed.exists());
	expect(files.todos.invalid().map(({ id }) => id)).toEqual(['b']);
	expect(unread.exists()).toBe(false);
	expect(unread.fields.title).toBeUndefined();

	// Another program deletes it: the editor says it is gone.
	const shown = expectOk(await device.todos.get({ id: 'a' }));
	expectOk(
		await (await open()).todos.delete({ id: 'a' }, { over: shown.version }),
	);
	await until(() => !listed.exists());
	expect(listed.fields.title).toBeUndefined();
	stop();
});

test('edit’s fields are the declared fields and the body, so a field named like a control is a field', async () => {
	const { open } = await folder();
	const files = over(todos, await open());
	expect(Object.keys(files.todos.edit({ id: 'a' }).fields)).toEqual([
		'title',
		'done',
		'body',
	]);

	const controls = defineContract({
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
	const root = await mkdtemp(join(tmpdir(), 'epicenter-note-edit-controls-'));
	folders.push(root);
	const device = unwrap(await openDevice(controls, { path: root }));
	expectOk(await device.notes.create({ id: 'a' }));
	const notes = over(controls, device).notes;
	expect(notes.fieldNames).toEqual(['error', 'exists', 'note']);
	const edit = notes.edit({ id: 'a' });
	expect(Object.keys(edit.fields)).toEqual(['error', 'exists', 'note', 'body']);
	const stop = edit.subscribe(() => {});
	await until(() => edit.exists());

	edit.fields.error = 'Not an error';
	edit.fields.note = 'A field';
	expect(edit.fields.error).toBe('Not an error');
	expect(edit.error()).toBeNull();
	expectOk(await edit.landed());
	expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe(
		'---\nerror: Not an error\nnote: A field\n---\n',
	);
	expect(edit.exists()).toBe(true);
	expect(edit.fields.exists).toBeUndefined();
	stop();
});

test('edit with create makes the note on the first save, then updates it; one made elsewhere first is saved over', async () => {
	const { open, text } = await folder();
	const device = await open();
	let creates = 0;
	const files = over(todos, {
		...device,
		todos: {
			...device.todos,
			create(...args: Parameters<TodoNotes['create']>) {
				creates++;
				return device.todos.create(...args);
			},
		},
	} as Client<Todos>);
	const stop = files.todos.subscribe(() => {});
	await until(() => !files.todos.loading());

	const create = () => ({ title: 'Draft', done: false });
	const draft = files.todos.edit({ id: 'a' }, { create });
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

	// Another program made `b` before this page heard of it: the save lands over theirs.
	expectOk(
		await (await open()).todos.create({ id: 'b', title: 'Theirs', done: true }),
	);
	const late = files.todos.edit({ id: 'b' }, { create });
	late.fields.body = 'Mine';
	expectOk(await late.landed());
	expect(await text('todos/b.md')).toBe(
		'---\ntitle: Theirs\ndone: true\n---\nMine',
	);
	stop();
});
