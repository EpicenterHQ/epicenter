/**
 * The note editor (`folder.todos.edit(args)`): one note as an immediate
 * editor, with no framework, over a folder in memory.
 *
 * Key behaviors:
 * - Saves go one at a time through the folder's queue, the newest carrying
 *   everything typed since the last that landed, so typing never clashes
 *   with itself
 * - A typed field takes this write; another writer's change to other
 *   fields stays; a body typed over a body changed since merges by lines
 * - `text` is the note's whole text, one that does not read included;
 *   typing it saves it, settled against the text it began from, and the
 *   typing stays shown while the file is what its save left
 * - The editor shows the newest typing until its save lands; `discard`
 *   shows the note; a save that cannot land waits, keeping the typing,
 *   and one the folder will not make rejects `landed()` with `FolderClosed`
 * - `fields` are the contract's fields and the body, and `exists()` says
 *   whether a note that reads is listed
 * - An editor nobody listens to holds nothing
 *
 * See also:
 * - `folder.writes.test.ts` for the collection's own reads and writes
 */
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { memoryStore } from './device/memory-store.js';
import type { Store } from './device/store.js';
import { createFolder } from './folder.js';
import { memory, memoryFiles } from './memory.js';
import { openFolder } from './open-folder.js';

const todos = defineContract({
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
	},
});

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

const note = (fields: string, body = '') => `---\n${fields}---\n${body}`;

/** A folder in memory, connected, the world outside it, and a count of the writes that reached the store. */
async function inMemory() {
	const store = memoryStore();
	const counts = { writes: 0, watching: 0 };
	const counted: Store = {
		...store,
		write(path, bytes, over) {
			counts.writes++;
			return store.write(path, bytes, over);
		},
		async watch(listener) {
			counts.watching++;
			const stop = await store.watch(listener);
			if (stop.error !== null) return stop;
			return Ok(() => {
				counts.watching--;
				stop.data();
			});
		},
	};
	const folder = createFolder(todos, async () => Ok(counted));
	await until(() => folder.state().status === 'open');
	return { folder, outside: store.outside, counts };
}

/** Listen to the collection, as a reader would, until the note `a` is shown. */
async function listening(folder: Awaited<ReturnType<typeof inMemory>>['folder']) {
	const stop = folder.todos.subscribe(() => {});
	await until(() => folder.todos.get({ id: 'a' }) !== undefined);
	return stop;
}

test('edit sends one save at a time, the newest carrying everything typed since the last landed', async () => {
	const { folder, outside, counts } = await inMemory();
	await outside.write('todos/a.md', note('title: ""\ndone: false\n'));
	const stop = await listening(folder);
	const todo = folder.todos.edit({ id: 'a' });

	const release = outside.hold();
	todo.fields.title = 'Oat';
	await until(() => counts.writes === 1);
	// Typed while the first save is out: one save after it carries them all.
	for (const typed of ['Oat ', 'Oat m', 'Oat milk']) todo.fields.title = typed;
	todo.fields.body = 'Two.\n';
	todo.fields.done = true;
	expect(todo.fields.title).toBe('Oat milk');
	release();
	await todo.landed();
	expect(outside.read('todos/a.md')).toBe(
		note('title: Oat milk\ndone: true\n', 'Two.\n'),
	);
	expect(counts.writes).toBe(2);
	expect(todo.typed()).toBeNull();
	expect(todo.fields.title).toBe('Oat milk');
	stop();
});

test('a keystroke is saving, on the editor and the folder, at once until it lands', async () => {
	const { folder, outside } = await inMemory();
	await outside.write('todos/a.md', note('title: ""\ndone: false\n'));
	const stop = await listening(folder);
	const todo = folder.todos.edit({ id: 'a' });
	let heard = 0;
	const stopHearing = todo.subscribe(() => heard++);

	expect(todo.saving()).toBe(false);
	todo.fields.title = 'Oat milk';
	expect(todo.saving()).toBe(true);
	expect(folder.saving()).toBe(true);
	expect(heard).toBeGreaterThan(0);
	await todo.landed();
	expect(todo.saving()).toBe(false);
	expect(folder.saving()).toBe(false);
	expect(outside.read('todos/a.md')).toBe(
		note('title: Oat milk\ndone: false\n'),
	);
	stopHearing();
	stop();
});

test('a typed field takes this write, and another writer’s change to another field stays', async () => {
	const { folder, outside } = await inMemory();
	await outside.write('todos/a.md', note('title: Milk\ndone: false\n'));
	const stop = await listening(folder);
	const todo = folder.todos.edit({ id: 'a' });
	const release = outside.hold();
	todo.fields.title = 'Oat milk';
	await Bun.sleep(5);
	await outside.write('todos/a.md', note('title: Bread\ndone: true\n'));
	release();
	await todo.landed();
	expect(outside.read('todos/a.md')).toBe(
		note('title: Oat milk\ndone: true\n'),
	);
	stop();
});

test('a body typed over a body changed since its typing began merges by lines', async () => {
	const { folder, outside } = await inMemory();
	const fields = 'title: Milk\ndone: false\n';
	await outside.write('todos/a.md', note(fields, 'one\ntwo\n'));
	const stop = await listening(folder);
	const todo = folder.todos.edit({ id: 'a' });
	const release = outside.hold();
	todo.fields.body = 'zero\none\ntwo\n';
	await Bun.sleep(5);
	await outside.write('todos/a.md', note(fields, 'one\ntwo\nthree\n'));
	release();
	await todo.landed();
	expect(outside.read('todos/a.md')).toBe(
		note(fields, 'zero\none\ntwo\nthree\n'),
	);
	stop();
});

test('text is the whole note, one that does not read included, and typing it saves it as typed', async () => {
	const { folder, outside } = await inMemory();
	await outside.write('todos/a.md', note('title: [\n', 'Body\n'));
	const stop = folder.todos.subscribe(() => {});
	await until(() => folder.todos.invalid().length === 1);
	const todo = folder.todos.edit({ id: 'a' });
	expect(todo.exists()).toBe(false);
	expect(todo.text).toBe(note('title: [\n', 'Body\n'));

	// Still broken: written as typed, and still invalid.
	todo.text = note('title: [x\n', 'Body\n');
	await todo.landed();
	expect(outside.read('todos/a.md')).toBe(note('title: [x\n', 'Body\n'));
	await until(
		() => folder.todos.invalid()[0]?.text === note('title: [x\n', 'Body\n'),
	);

	// Repaired: it reads, in house style.
	todo.text = note('done: false\ntitle: Milk\n', 'Body\n');
	await todo.landed();
	expect(outside.read('todos/a.md')).toBe(
		note('title: Milk\ndone: false\n', 'Body\n'),
	);
	await until(() => todo.exists());
	expect(folder.todos.invalid()).toEqual([]);
	// What was typed stays shown while the file is what its save left.
	expect(todo.text).toBe(note('done: false\ntitle: Milk\n', 'Body\n'));
	// A change made elsewhere shows.
	await outside.write(
		'todos/a.md',
		note('title: Oat milk\ndone: false\n', 'Body\n'),
	);
	await until(
		() => todo.text === note('title: Oat milk\ndone: false\n', 'Body\n'),
	);
	stop();
});

test('whole text typed over a note changed since the typing began is settled, keeping both', async () => {
	const { folder, outside } = await inMemory();
	await outside.write(
		'todos/a.md',
		note('title: Milk\ndone: false\n', 'one\n'),
	);
	const stop = await listening(folder);
	const todo = folder.todos.edit({ id: 'a' });
	const release = outside.hold();
	todo.text = note('title: Milk\ndone: false\n', 'one\ntwo\n');
	await Bun.sleep(5);
	await outside.write(
		'todos/a.md',
		note('title: Milk\ndone: true\n', 'zero\none\n'),
	);
	release();
	await todo.landed();
	expect(outside.read('todos/a.md')).toBe(
		note('title: Milk\ndone: true\n', 'zero\none\ntwo\n'),
	);
	// The editor shows what was merged in, not only what was typed.
	await until(
		() => todo.text === note('title: Milk\ndone: true\n', 'zero\none\ntwo\n'),
	);
	stop();
});

test('edit shows the newest typing until its save lands, and discard shows the note', async () => {
	const { folder, outside, counts } = await inMemory();
	await outside.write('todos/a.md', note('title: Milk\ndone: false\n'));
	const stop = await listening(folder);
	const todo = folder.todos.edit({ id: 'a' });

	const release = outside.hold();
	todo.fields.title = 'Oat';
	await until(() => counts.writes === 1);
	todo.fields.title = 'Oat milk';
	expect(todo.fields.title).toBe('Oat milk');
	expect(todo.typed()).toEqual({ title: 'Oat milk' });
	// Discarding shows the note again; the save already out still lands, and what was not sent is not.
	todo.discard();
	expect(todo.fields.title).toBe('Milk');
	release();
	await todo.landed();
	await until(() => !folder.saving());
	expect(outside.read('todos/a.md')).toBe(note('title: Oat\ndone: false\n'));
	await until(() => todo.fields.title === 'Oat');
	stop();
});

test('a save that cannot land waits, the typing still shown, and lands when the store is back', async () => {
	const { folder, outside } = await inMemory();
	await outside.write('todos/a.md', note('title: Milk\ndone: false\n'));
	const stop = await listening(folder);
	const todo = folder.todos.edit({ id: 'a' });
	const undo = outside.refuse('offline');
	todo.fields.title = 'Oat milk';
	await until(() => folder.unavailable() !== null);
	expect(todo.fields.title).toBe('Oat milk');
	expect(todo.saving()).toBe(true);
	undo();
	await todo.landed();
	expect(outside.read('todos/a.md')).toBe(
		note('title: Oat milk\ndone: false\n'),
	);
	expect(folder.unavailable()).toBeNull();
	stop();
});

test('a save the folder will not make rejects landed() with FolderClosed, and the typing stays shown', async () => {
	const { folder, outside } = await inMemory();
	await outside.write('todos/a.md', note('title: Milk\ndone: false\n'));
	const stop = await listening(folder);
	const todo = folder.todos.edit({ id: 'a' });
	outside.refuse('offline');
	todo.fields.title = 'Oat milk';
	await until(() => folder.unavailable() !== null);
	const waiting = todo.landed();
	stop();
	folder[Symbol.dispose]();
	// Rejected, not left unhandled: the keystroke's own save is the editor's.
	await expect(waiting).rejects.toMatchObject({
		name: 'FolderClosed',
		status: 'closed',
	});
	expect(todo.fields.title).toBe('Oat milk');
	expect(outside.read('todos/a.md')).toBe(note('title: Milk\ndone: false\n'));
});

test('an editor holds nothing of its own: it reads what the folder holds, heard or not', async () => {
	const { folder, outside, counts } = await inMemory();
	await outside.write('todos/a.md', note('title: Milk\ndone: false\n'));
	const todo = folder.todos.edit({ id: 'a' });
	await until(() => todo.exists());
	// The folder hears its files from the open, for every reader at once.
	expect(counts.watching).toBe(1);
	const stop = todo.subscribe(() => {});
	expect(counts.watching).toBe(1);
	stop();
});

test('edit’s exists() is whether a note that reads is listed at its path', async () => {
	const { folder, outside } = await inMemory();
	await outside.write('todos/a.md', note('title: Milk\ndone: false\n'));
	await outside.write('todos/b.md', note('title: [\n'));
	const listed = folder.todos.edit({ id: 'a' });
	const unread = folder.todos.edit({ id: 'b' });

	const stop = listed.subscribe(() => {});
	await until(() => listed.exists());
	expect(folder.todos.invalid().map(({ id }) => id)).toEqual(['b']);
	expect(unread.exists()).toBe(false);
	expect(unread.fields.title).toBeUndefined();

	await outside.write('todos/a.md', null);
	await until(() => !listed.exists());
	expect(listed.fields.title).toBeUndefined();
	stop();
});

test('edit’s fields are the declared fields and the body, so a field named like a control is a field', async () => {
	const controls = defineContract({
		collections: {
			notes: {
				path: 'notes/{id}.md',
				fields: {
					saving: { type: 'string' },
					exists: { type: 'string' },
					text: { type: 'string' },
				},
			},
		},
	});
	const place = memory();
	const notes = openFolder(controls, place).notes;
	await notes.set({ id: 'a' }, {});
	expect(notes.fieldNames).toEqual(['saving', 'exists', 'text']);
	const edit = notes.edit({ id: 'a' });
	expect(Object.keys(edit.fields)).toEqual([
		'saving',
		'exists',
		'text',
		'body',
	]);
	const stop = edit.subscribe(() => {});
	await until(() => edit.exists());

	edit.fields.saving = 'Not a control';
	edit.fields.text = 'A field';
	expect(edit.fields.saving).toBe('Not a control');
	await edit.landed();
	expect(memoryFiles(place).read('notes/a.md')).toBe(
		note('saving: Not a control\ntext: A field\n'),
	);
	expect(edit.text).toBe(note('saving: Not a control\ntext: A field\n'));
	expect(edit.fields.exists).toBeUndefined();
	stop();
});

test('edit with create makes the note on the first save; one made elsewhere first keeps its fields', async () => {
	const { folder, outside } = await inMemory();
	const stop = folder.todos.subscribe(() => {});

	const create = () => ({ title: 'Draft', done: false });
	const draft = folder.todos.edit({ id: 'a' }, { create });
	for (const typed of ['H', 'Hi', 'Hi there']) draft.fields.body = typed;
	await draft.landed();
	expect(outside.read('todos/a.md')).toBe(
		note('title: Draft\ndone: false\n', 'Hi there'),
	);
	draft.fields.body = 'Hi there!';
	await draft.landed();
	expect(outside.read('todos/a.md')).toBe(
		note('title: Draft\ndone: false\n', 'Hi there!'),
	);

	// Another program made `b` before this page heard of it: the typing lands in theirs.
	stop();
	await outside.write('todos/b.md', note('title: Theirs\ndone: true\n'));
	const late = folder.todos.edit({ id: 'b' }, { create });
	late.fields.body = 'Mine';
	await late.landed();
	expect(outside.read('todos/b.md')).toBe(
		note('title: Theirs\ndone: true\n', 'Mine'),
	);
});
