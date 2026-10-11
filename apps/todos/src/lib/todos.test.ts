/**
 * Todos Store Tests
 *
 * Drives the real Todos store against a real browser folder over an
 * in-memory OPFS stand-in.
 *
 * Key behaviors:
 * - An open todo saves each edit at once, and rapid edits write the latest
 *   draft, never every intermediate one
 * - A change made elsewhere is a conflict: Reload theirs shows it, Keep mine
 *   saves the draft over it, and nothing is written until the person chooses
 * - A file deleted elsewhere is a conflict too: Keep mine creates it again
 *   from the draft, Discard closes it
 * - A draft that is not a valid row is never written
 * - A todo whose text is not a valid row opens as text with its issues,
 *   saves as typed, and reopens as a todo once repaired
 * - Rename and delete wait for the open item's saves and act on what the
 *   last one confirmed; a draft that could not save refuses both
 * - Leaving an item whose save failed answers `unsaved` until the person
 *   discards it
 * - Returning to the window adopts a newer version of an open item that
 *   holds nothing unsaved
 * - A list toggle on a closed todo is guarded by the version the list read
 * - Renaming or deleting a todo moves or removes only its Markdown file
 * - Close waits for running work, and every close call shares one completion
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createTestStorage,
	opfsOf,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from './definition.js';
import { holdCloses } from './opfs-holds.test-support.js';
import type { TodosFolder } from './platform/types.js';
import type { Todos } from './todos.svelte.js';

/** The open item's session, whatever kind. */
function openSession(todos: Todos) {
	const item = todos.opened;
	if (item?.kind !== 'todo' && item?.kind !== 'text')
		throw new Error(`Expected an open session, got ${item?.kind}`);
	return item.session;
}

const { createTodos } = await import('./todos.svelte.ts');

const opened: Todos[] = [];
let count = 0;

afterEach(async () => {
	for (const todos of opened.splice(0)) await todos.close();
});

/**
 * The store over a fresh folder. `holdNextMarkdownWrite` holds the next
 * published `.md` write until the returned function runs, and `mdWrites`
 * counts every published `.md` write.
 */
async function open(
	adapt: (folder: TodosFolder) => TodosFolder = (folder) => folder,
	remote?: { url: string; branch: string },
) {
	const storage = createTestStorage();
	let hold: PromiseWithResolvers<void> | undefined;
	let held: PromiseWithResolvers<void> | undefined;
	const counter = { mdWrites: 0 };
	const folder = expectOk(
		await openFolder({
			id: `todos-test-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				remote,
				opfs: {
					locks: testLocks,
					getDirectory: async () =>
						holdCloses(await storage.opfs.getDirectory(), async (file) => {
							if (!file.name.endsWith('.md')) return;
							counter.mdWrites++;
							const gate = hold;
							if (gate === undefined) return;
							hold = undefined;
							held?.resolve();
							await gate.promise;
						}),
				},
			},
		}),
	);
	const todos = createTodos(adapt(folder));
	opened.push(todos);
	await todos.check();
	const faults = opfsOf(storage).faults;
	return {
		todos,
		counter,
		holdNextMarkdownWrite() {
			hold = Promise.withResolvers<void>();
			held = Promise.withResolvers<void>();
			return { held: held.promise, release: hold.resolve };
		},
		/** The next write of `path` fails before it publishes. */
		failNextWrite(path: string) {
			faults.write = (file) => {
				if (!file.endsWith(`/${path}`)) return undefined;
				faults.write = undefined;
				return 'fail';
			};
		},
	};
}

async function text(todos: Todos, path: string) {
	const read = await todos.folder.files.read(path);
	return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
}

/** A folder whose Git methods a test replaces. */
function withGit(
	git: Partial<
		Pick<TodosFolder['git'], 'fetch' | 'mergeIncoming' | 'pullFastForward'>
	>,
) {
	return (folder: TodosFolder): TodosFolder => ({
		...folder,
		// The folder's Git is frozen; these methods shadow its own.
		git: Object.create(
			folder.git,
			Object.fromEntries(
				Object.entries(git).map(([key, value]) => [key, { value }]),
			),
		),
	});
}

/** Another program writes the file. */
async function writeElsewhere(todos: Todos, path: string, content: string) {
	expectOk(await todos.folder.files.overwrite(path, content));
}

/** Another program deletes the file as it is now. */
async function deleteElsewhere(todos: Todos, path: string) {
	const { files } = todos.folder;
	expectOk(await files.remove(expectOk(await files.read(path))));
}

function todoSession(todos: Todos) {
	const item = todos.opened;
	if (item?.kind !== 'todo')
		throw new Error(`Expected an open todo, got ${item?.kind}`);
	return item.session;
}

function textSession(todos: Todos) {
	const item = todos.opened;
	if (item?.kind !== 'text')
		throw new Error(`Expected open text, got ${item?.kind}`);
	return item.session;
}

async function addTodo(todos: Todos, title: string) {
	expect(await todos.create(title)).toBeUndefined();
	return todoSession(todos);
}

// ============================================================================
// Saving an open todo
// ============================================================================

test('each edit saves at once, and rapid edits write only the latest draft', async () => {
	const { todos, counter, holdNextMarkdownWrite } = await open();
	const session = await addTodo(todos, 'Milk');
	const { held, release } = holdNextMarkdownWrite();
	session.edit((row) => {
		row.fields.title = 'M';
	});
	await held;
	const before = counter.mdWrites;
	for (const title of ['Mi', 'Mil', 'Milk!', 'Milk!!'])
		session.edit((row) => {
			row.fields.title = title;
		});
	expect(session.state.status).toBe('saving');
	release();
	expect((await session.settled()).status).toBe('saved');
	// The held write, then one write of the latest draft.
	expect(counter.mdWrites - before).toBe(1);
	expect(await text(todos, session.path)).toContain('Milk!!');
	expect(session.draft.fields.title).toBe('Milk!!');
});

test('a save never assigns the draft: edits made while a save runs stay on screen', async () => {
	const { todos, holdNextMarkdownWrite } = await open();
	const session = await addTodo(todos, 'Milk');
	const { held, release } = holdNextMarkdownWrite();
	session.edit((row) => {
		row.body = 'first\n';
	});
	await held;
	session.edit((row) => {
		row.body = 'second\n';
	});
	release();
	await session.settled();
	expect(session.draft.body).toBe('second\n');
	expect(await text(todos, session.path)).toContain('second');
});

test('a draft that is not a valid row is never written, and the next valid edit saves', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	const saved = await text(todos, session.path);
	session.edit((row) => {
		(row.fields as { title: unknown }).title = 42;
	});
	const state = await session.settled();
	expect(state.status).toBe('error');
	expect(state.status === 'error' && state.error.name).toBe('InvalidValues');
	expect(await text(todos, session.path)).toBe(saved);
	session.edit((row) => {
		row.fields.title = 'Oat milk';
	});
	expect((await session.settled()).status).toBe('saved');
	expect(await text(todos, session.path)).toContain('title: Oat milk');
});

test('a failed save keeps the draft; Try again saves it', async () => {
	const { todos, failNextWrite } = await open();
	const session = await addTodo(todos, 'Milk');
	failNextWrite(session.path);
	session.edit((row) => {
		row.fields.title = 'Bread';
	});
	expect((await session.settled()).status).toBe('error');
	expect(session.draft.fields.title).toBe('Bread');
	expect(todos.saveProblems).toBe(1);
	session.retry();
	expect((await session.settled()).status).toBe('saved');
	expect(await text(todos, session.path)).toContain('title: Bread');
});

// ============================================================================
// The conflict prompt
// ============================================================================

test('a change made elsewhere is a conflict, and Reload theirs shows it without writing', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	const theirs = '---\ntitle: Theirs\ndone: true\n---\nfrom elsewhere\n';
	await writeElsewhere(todos, session.path, theirs);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(await text(todos, session.path)).toBe(theirs);

	expect(await todos.reloadTheirs(openSession(todos))).toBeUndefined();
	const reloaded = todoSession(todos);
	expect(reloaded.draft.fields).toEqual({ title: 'Theirs', done: true });
	expect(reloaded.draft.body).toBe('from elsewhere\n');
	expect(reloaded.state.status).toBe('saved');
	expect(await text(todos, session.path)).toBe(theirs);
	// The session saves again from what it reloaded.
	reloaded.edit((row) => {
		row.fields.done = false;
	});
	expect((await reloaded.settled()).status).toBe('saved');
	expect(await text(todos, session.path)).toContain('done: false');
});

test('Keep mine takes the draft where both changed and keeps what changed elsewhere in other fields', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	await writeElsewhere(
		todos,
		session.path,
		'---\ntitle: Theirs\ndone: true\n---\n',
	);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(await todos.keepMine(openSession(todos))).toBeUndefined();
	expect((await session.settled()).status).toBe('saved');
	const saved = await text(todos, session.path);
	expect(saved).toContain('title: Mine');
	expect(saved).toContain('done: true');
});

test('a file deleted elsewhere is a conflict: Keep mine creates it again from the draft', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	await deleteElsewhere(todos, session.path);
	session.edit((row) => {
		row.fields.title = 'Still mine';
	});
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(
		state.status === 'error' &&
			state.error.name === 'Conflict' &&
			state.error.actualSha256,
	).toBeUndefined();
	// A deleted file is never recreated by a save.
	expect(await text(todos, session.path)).toBeUndefined();

	expect(await todos.keepMine(openSession(todos))).toBeUndefined();
	expect(await text(todos, session.path)).toContain('title: Still mine');
	expect(session.state.status).toBe('saved');
	session.edit((row) => {
		row.body = 'after\n';
	});
	expect((await session.settled()).status).toBe('saved');
});

test('a file deleted elsewhere: Discard closes it without writing', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	await deleteElsewhere(todos, session.path);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(await todos.reloadTheirs(openSession(todos))).toBeUndefined();
	expect(todos.opened).toBeUndefined();
	expect(await text(todos, session.path)).toBeUndefined();
	// The closed session takes nothing more.
	session.edit((row) => {
		row.fields.title = 'Late';
	});
	await session.settled();
	expect(await text(todos, session.path)).toBeUndefined();
});

test('Reload theirs of a todo made invalid elsewhere opens its text with the issues', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	await writeElsewhere(todos, session.path, '---\ntitle: [unclosed\n---\n');
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(await todos.reloadTheirs(openSession(todos))).toBeUndefined();
	expect(todos.current).toEqual({ path: session.path, workspace: 'todos' });
	expect(textSession(todos).draft).toBe('---\ntitle: [unclosed\n---\n');
});

test('input is locked while Keep mine runs, so a recreated file holds the draft on screen', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	await deleteElsewhere(todos, session.path);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	const keeping = todos.keepMine(session);
	expect(session.locked).toBe(true);
	session.edit((row) => {
		row.fields.title = 'Refused';
	});
	expect(await keeping).toBeUndefined();
	expect(session.draft.fields.title).toBe('Mine');
	expect(await text(todos, session.path)).toContain('title: Mine');
});

test('Keep mine saves over a file that is no longer text', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	expectOk(
		await todos.folder.files.overwrite(
			session.path,
			new Uint8Array([0xff, 0xfe, 0x00]),
		),
	);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(await todos.keepMine(session)).toBeUndefined();
	await session.settled();
	expect(await text(todos, session.path)).toContain('title: Mine');
});

test('Reload theirs of a file that is no longer text opens it again as it is now', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	expectOk(
		await todos.folder.files.overwrite(
			session.path,
			new Uint8Array([0xff, 0xfe, 0x00]),
		),
	);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(await todos.reloadTheirs(session)).toBeUndefined();
	// A todo row that is not text cannot load as a todo; the detail says why.
	expect(todos.opened?.kind).toBe('failed');
	expect(todos.current).toEqual({ path: session.path, workspace: 'todos' });
	// The conflicted session was released: Keep mine for it does nothing.
	expect(await todos.keepMine(session)).toBeUndefined();
	expect(session.locked).toBe(true);

	// Opened from Files, the same file reloads as file details.
	expectOk(await todos.folder.files.overwrite(session.path, 'text again'));
	expect(await todos.open(session.path, 'files')).toMatchObject({
		kind: 'done',
	});
	const file = textSession(todos);
	expectOk(
		await todos.folder.files.overwrite(
			session.path,
			new Uint8Array([0xff, 0xfe, 0x00]),
		),
	);
	file.input('mine');
	await file.settled();
	expect(await todos.reloadTheirs(file)).toBeUndefined();
	expect(todos.opened).toMatchObject({ kind: 'binary', path: session.path });
});

test('leaving a todo lists it again, so a toggle from the list uses what was saved', async () => {
	const { todos } = await open();
	const milk = await addTodo(todos, 'Milk');
	milk.edit((row) => {
		row.fields.title = 'Oat milk';
	});
	await addTodo(todos, 'Bread');
	await todos.refresh();
	const entry = todos.entries.find((e) => e.path === milk.path)!;
	expect(entry.row.fields.title).toBe('Oat milk');
	expect(await todos.toggle(entry)).toBeUndefined();
});

test('text input is kept well formed, so what saves is what is shown', async () => {
	const { todos } = await open();
	expectOk(await todos.folder.files.create('notes.txt', ''));
	await todos.open('notes.txt', 'files');
	const session = textSession(todos);
	session.input('a\uD800b');
	await session.settled();
	expect(session.draft).toBe('a\uFFFDb');
	expect(await text(todos, 'notes.txt')).toBe(session.draft);
});

// ============================================================================
// Invalid rows are repaired as text
// ============================================================================

test('a row that is not a valid todo is named for repair, opens as text, saves as typed, and reopens as a todo', async () => {
	const { todos } = await open();
	const path = 'todos/broken.md';
	expectOk(
		await todos.folder.files.create(path, '---\ntitle: Broken\n---\nnotes\n'),
	);
	await todos.refresh();
	expect(todos.entries).toEqual([]);
	expect(todos.repairs).toEqual([
		{ path, reason: expect.stringContaining('done') },
	]);

	expect(await todos.open(path, 'todos')).toMatchObject({ kind: 'done' });
	const session = textSession(todos);
	expect(todos.current).toEqual({ path, workspace: 'todos' });
	session.input('---\ntitle: Broken\ndone: tru\n---\nnotes\n');
	expect((await session.settled()).status).toBe('saved');
	// Invalid text saves exactly as typed.
	expect(await text(todos, path)).toBe(
		'---\ntitle: Broken\ndone: tru\n---\nnotes\n',
	);
	session.input('---\ntitle: Broken\ndone: true\n---\nnotes\n');
	await session.settled();

	// The repair text is shown under its own key, so opening it as a todo
	// leaves the text and opens the row.
	expect(await todos.open(path, 'todos')).toEqual({ kind: 'done', left: true });
	expect(session.locked).toBe(true);
	const repaired = todoSession(todos);
	expect(repaired.draft).toEqual({
		fields: { title: 'Broken', done: true },
		body: 'notes\n',
	});
	await todos.refresh();
	expect(todos.repairs).toEqual([]);
	expect(todos.entries.map((entry) => entry.path)).toEqual([path]);
});

test('Files opens a todo as its exact text, and a conflict there offers the same choices', async () => {
	const { todos } = await open();
	const row = await addTodo(todos, 'Milk');
	const path = row.path;
	expect(await todos.open(path, 'files')).toMatchObject({ kind: 'done' });
	const session = textSession(todos);
	expect(session.draft).toBe((await text(todos, path))!);
	await writeElsewhere(todos, path, '---\ntitle: Theirs\ndone: false\n---\n');
	session.input(session.draft.replace('title: Milk', 'title: Mine'));
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(session.review?.conflicts.map(({ kind }) => kind)).toEqual(['body']);
	expect(await todos.keepMine(openSession(todos))).toBeUndefined();
	await session.settled();
	expect(await text(todos, path)).toBe(session.draft);
});

// ============================================================================
// Leaving an item
// ============================================================================

test('opening another item waits for saves, and a failed save answers unsaved until discarded', async () => {
	const { todos, failNextWrite } = await open();
	const milk = await addTodo(todos, 'Milk');
	const bread = await addTodo(todos, 'Bread');
	failNextWrite(bread.path);
	bread.edit((row) => {
		row.fields.title = 'Rye';
	});
	expect(await todos.open(milk.path, 'todos')).toEqual({
		kind: 'unsaved',
		session: bread,
	});
	expect(todoSession(todos)).toBe(bread);
	expect(todos.unsaved).toBe(true);

	// A discard names the draft it lets go; any other answers unsaved again.
	expect(await todos.open(milk.path, 'todos', { discard: milk })).toMatchObject(
		{ kind: 'unsaved' },
	);
	expect(await todos.open(milk.path, 'todos', { discard: bread })).toEqual({
		kind: 'done',
		left: true,
	});
	expect(todoSession(todos).path).toBe(milk.path);
	// The released session takes nothing more.
	bread.edit((row) => {
		row.fields.title = 'Late';
	});
	expect(bread.draft.fields.title).toBe('Rye');
	expect(await text(todos, bread.path)).toContain('title: Bread');
	expect(todos.unsaved).toBe(false);
});

test('opening another item after an edit saves that edit first', async () => {
	const { todos } = await open();
	const milk = await addTodo(todos, 'Milk');
	const bread = await addTodo(todos, 'Bread');
	bread.edit((row) => {
		row.body = 'whole grain\n';
	});
	expect(await todos.open(milk.path, 'todos')).toMatchObject({ kind: 'done' });
	expect(await text(todos, bread.path)).toContain('whole grain');
});

test('opening the item already shown does nothing, even when its save failed', async () => {
	const { todos, failNextWrite } = await open();
	const milk = await addTodo(todos, 'Milk');
	failNextWrite(milk.path);
	milk.edit((row) => {
		row.fields.title = 'Mine';
	});
	await milk.settled();
	expect(await todos.open(milk.path, 'todos')).toEqual({
		kind: 'done',
		left: false,
	});
	expect(todoSession(todos)).toBe(milk);
	expect(milk.draft.fields.title).toBe('Mine');
	expect(milk.locked).toBe(false);
});

test('a discard after Reload theirs swapped the session applies to the session the open answered', async () => {
	const { todos, failNextWrite } = await open();
	const bread = await addTodo(todos, 'Bread');
	const milk = await addTodo(todos, 'Milk');
	await writeElsewhere(todos, milk.path, '---\ntitle: [unclosed\n---\n');
	milk.edit((row) => {
		row.fields.title = 'Mine';
	});
	await milk.settled();
	expect(await todos.reloadTheirs(milk)).toBeUndefined();
	const repair = textSession(todos);
	failNextWrite(milk.path);
	repair.input('---\ntitle: still broken\n---\n');
	await repair.settled();

	// The session the view held before Reload theirs is not the one asked about.
	expect(await todos.open(bread.path, 'todos', { discard: milk })).toEqual({
		kind: 'unsaved',
		session: repair,
	});
	expect(
		await todos.open(bread.path, 'todos', { discard: repair }),
	).toMatchObject({ kind: 'done' });
	expect(todoSession(todos).path).toBe(bread.path);
});

test('a renamed open todo keeps its place: opening it at its new path does nothing, and Reload theirs finds it there', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	expect(await todos.rename(session.path, 'renamed.md')).toBeUndefined();
	expect(await todos.open('todos/renamed.md', 'todos')).toEqual({
		kind: 'done',
		left: false,
	});
	expect(todoSession(todos)).toBe(session);
	await writeElsewhere(todos, session.path, '---\ntitle: [unclosed\n---\n');
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(await todos.reloadTheirs(session)).toBeUndefined();
	expect(textSession(todos).path).toBe('todos/renamed.md');
	expect(todos.current).toEqual({
		path: 'todos/renamed.md',
		workspace: 'todos',
	});
});

// ============================================================================
// Returning to the window
// ============================================================================

test('returning adopts a newer version of an open todo that holds nothing unsaved', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	await writeElsewhere(
		todos,
		session.path,
		'---\ntitle: Theirs\ndone: false\n---\n',
	);
	await todos.check();
	expect(session.draft.fields.title).toBe('Theirs');
	expect(todos.entries[0]?.row.fields.title).toBe('Theirs');
	session.edit((row) => {
		row.fields.done = true;
	});
	expect((await session.settled()).status).toBe('saved');
});

test('returning leaves a draft whose save failed as it is', async () => {
	const { todos, failNextWrite } = await open();
	const session = await addTodo(todos, 'Milk');
	failNextWrite(session.path);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	await writeElsewhere(
		todos,
		session.path,
		'---\ntitle: Theirs\ndone: false\n---\n',
	);
	await todos.check();
	expect(session.draft.fields.title).toBe('Mine');
	session.retry();
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
});

// ============================================================================
// List toggles
// ============================================================================

test('a toggle on the open todo is an edit to its draft', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	session.edit((row) => {
		row.body = 'typed\n';
	});
	const entry = todos.entries[0]!;
	expect(await todos.toggle(entry)).toBeUndefined();
	await session.settled();
	expect(session.draft.fields.done).toBe(true);
	const saved = await text(todos, session.path);
	expect(saved).toContain('done: true');
	expect(saved).toContain('typed');
});

test('a toggle on a closed todo replaces it, guarded by the version the list read', async () => {
	const { todos } = await open();
	const milk = await addTodo(todos, 'Milk');
	await addTodo(todos, 'Bread');
	await todos.refresh();
	const entry = todos.entries.find((e) => e.path === milk.path)!;
	expect(await todos.toggle(entry)).toBeUndefined();
	expect(await text(todos, milk.path)).toContain('done: true');

	// The listed version is stale now: the toggle refuses and writes nothing.
	const stale = entry;
	await writeElsewhere(
		todos,
		milk.path,
		'---\ntitle: Theirs\ndone: false\n---\n',
	);
	expect(await todos.toggle(stale)).toContain('changed elsewhere');
	expect(await text(todos, milk.path)).toContain('title: Theirs');
});

// ============================================================================
// Rename and delete
// ============================================================================

const PNG = new Uint8Array([0x89, 0x50, 0]);

test('renaming an open todo moves only its Markdown file after its saves land; input is locked meanwhile, and later edits save at the new path', async () => {
	const { todos, holdNextMarkdownWrite } = await open();
	const session = await addTodo(todos, 'Milk');
	const stem = session.path.replace(/\.md$/, '');
	expectOk(await todos.folder.files.create(`${stem}.png`, PNG));
	const { held, release } = holdNextMarkdownWrite();
	session.edit((row) => {
		row.body = 'before\n';
	});
	await held;
	const renaming = todos.rename(session.path, 'renamed.md');
	expect(session.locked).toBe(true);
	session.edit((row) => {
		row.body = 'refused\n';
	});
	expect(session.draft.body).toBe('before\n');
	release();
	expect(await renaming).toBeUndefined();
	expect(session.path).toBe('todos/renamed.md');
	expect(session.locked).toBe(false);
	session.edit((row) => {
		row.body = 'after\n';
	});
	await session.settled();
	expect(await text(todos, 'todos/renamed.md')).toContain('after');
	expect(await text(todos, `${stem}.md`)).toBeUndefined();
	expect(expectOk(await todos.folder.files.read(`${stem}.png`)).bytes).toEqual(
		PNG,
	);
});

test('renaming an open todo whose save failed moves what was saved and saves the draft at the new path', async () => {
	const { todos, failNextWrite } = await open();
	const session = await addTodo(todos, 'Milk');
	failNextWrite(session.path);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(await todos.rename(session.path, 'other.md')).toBeUndefined();
	expect((await session.settled()).status).toBe('saved');
	expect(await text(todos, 'todos/other.md')).toContain('title: Mine');
});

test('a rename of a conflicted todo is refused by the guard, and the draft stays', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	await writeElsewhere(
		todos,
		session.path,
		'---\ntitle: Theirs\ndone: false\n---\n',
	);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(await todos.rename(session.path, 'other.md')).toContain(
		'changed elsewhere',
	);
	expect(session.draft.fields.title).toBe('Mine');
	expect(await text(todos, 'todos/other.md')).toBeUndefined();
});

test('deleting the open todo waits for its saves, removes only its Markdown file, and closes it', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	const stem = session.path.replace(/\.md$/, '');
	expectOk(await todos.folder.files.create(`${stem}.png`, PNG));
	session.edit((row) => {
		row.fields.title = 'Oat milk';
	});
	const deletion = expectOk(await todos.deletionFor(session.path));
	expect(deletion).toMatchObject({ kind: 'todo', title: 'Oat milk' });
	expect(await todos.remove(deletion)).toBeUndefined();
	expect(await text(todos, session.path)).toBeUndefined();
	expect(todos.opened).toBeUndefined();
	expect(todos.entries).toEqual([]);
	expect(expectOk(await todos.folder.files.read(`${stem}.png`)).bytes).toEqual(
		PNG,
	);
});

test('edits made while the delete dialog is open are saved before the delete, which then removes the file', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	const deletion = expectOk(await todos.deletionFor(session.path));
	session.edit((row) => {
		row.fields.title = 'Typed during the dialog';
	});
	expect(await todos.remove(deletion)).toBeUndefined();
	expect(await text(todos, session.path)).toBeUndefined();
	expect(todos.opened).toBeUndefined();
});

test('a refused delete of the open todo reopens it as it is now, and it saves again', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	const deletion = expectOk(await todos.deletionFor(session.path));
	await writeElsewhere(
		todos,
		session.path,
		'---\ntitle: Theirs\ndone: false\n---\n',
	);
	expect(await todos.remove(deletion)).toContain('changed elsewhere');
	const reopened = todoSession(todos);
	expect(reopened).not.toBe(session);
	expect(reopened.draft.fields.title).toBe('Theirs');
	reopened.edit((row) => {
		row.fields.done = true;
	});
	expect((await reopened.settled()).status).toBe('saved');
	expect(await text(todos, session.path)).toContain('done: true');
});

test('a delete is refused when the file changed after it was confirmed', async () => {
	const { todos } = await open();
	expectOk(await todos.folder.files.create('notes.txt', 'first'));
	await todos.refresh();
	const deletion = expectOk(await todos.deletionFor('notes.txt'));
	await writeElsewhere(todos, 'notes.txt', 'second');
	expect(await todos.remove(deletion)).toContain('changed elsewhere');
	expect(await text(todos, 'notes.txt')).toBe('second');
});

test('a folder is deleted only when it is empty', async () => {
	const { todos } = await open();
	expect(await todos.createFolder('', 'docs')).toBeUndefined();
	expect(await todos.createFile('docs', 'a.txt')).toBeUndefined();
	expect(expectErr(await todos.deletionFor('docs'))).toContain(
		'Only empty folders',
	);
	const file = expectOk(await todos.deletionFor('docs/a.txt'));
	expect(await todos.remove(file)).toBeUndefined();
	await todos.refresh();
	const folder = expectOk(await todos.deletionFor('docs'));
	expect(await todos.remove(folder)).toBeUndefined();
});

// ============================================================================
// Close and Git
// ============================================================================

test('close waits for running saves, and every close call shares one completion', async () => {
	const { todos, holdNextMarkdownWrite } = await open();
	const session = await addTodo(todos, 'Milk');
	const { held, release } = holdNextMarkdownWrite();
	session.edit((row) => {
		row.fields.title = 'Closing';
	});
	await held;
	const first = todos.close();
	expect(todos.close()).toBe(first);
	release();
	expect(await first).toEqual({ unsettled: [] });
	// Reopen the same storage is out of scope; the save landed before close.
	expect(session.state.status).toBe('saved');
});

test('a refused delete after renaming the open todo reopens it at its new path', async () => {
	const { todos } = await open();
	const session = await addTodo(todos, 'Milk');
	expect(await todos.rename(session.path, 'renamed.md')).toBeUndefined();
	const deletion = expectOk(await todos.deletionFor('todos/renamed.md'));
	await writeElsewhere(
		todos,
		'todos/renamed.md',
		'---\ntitle: Theirs\ndone: false\n---\n',
	);
	expect(await todos.remove(deletion)).toContain('changed elsewhere');
	const reopened = todoSession(todos);
	expect(reopened).not.toBe(session);
	expect(reopened.path).toBe('todos/renamed.md');
	expect(reopened.draft.fields.title).toBe('Theirs');
});

test('Try again reads an item that failed to load again', async () => {
	const { todos } = await open();
	expect(await todos.open('todos/gone.md', 'todos')).toMatchObject({
		kind: 'done',
	});
	expect(todos.opened?.kind).toBe('failed');
	expect(await todos.open('todos/gone.md', 'todos')).toEqual({
		kind: 'done',
		left: false,
	});
	expectOk(
		await todos.folder.files.create(
			'todos/gone.md',
			'---\ntitle: Back\ndone: false\n---\n',
		),
	);
	await todos.reload();
	expect(todoSession(todos).draft.fields.title).toBe('Back');
});

test('close waits for a closed-file rename whose read is still running', async () => {
	let hold: PromiseWithResolvers<void> | undefined;
	const reading = Promise.withResolvers<void>();
	const { todos } = await open((folder) => ({
		...folder,
		files: Object.create(folder.files, {
			read: {
				async value(path: string) {
					const gate = hold;
					if (gate !== undefined && path === 'notes.txt') {
						hold = undefined;
						reading.resolve();
						await gate.promise;
					}
					return folder.files.read(path);
				},
			},
		}),
	}));
	expectOk(await todos.folder.files.create('notes.txt', 'first'));
	await todos.refresh();
	hold = Promise.withResolvers<void>();
	const release = hold.resolve;
	const renaming = todos.rename('notes.txt', 'renamed.txt');
	await reading.promise;
	expect(todos.departure.holdsUnsaved).toBe(true);
	let closed = false;
	const closing = todos.close().then(() => {
		closed = true;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	release();
	// The move ran on the open folder, before close released it.
	expect(await renaming).toBeUndefined();
	await closing;
});

test('renaming another file while a todo is open is not held to the .md rule', async () => {
	const { todos } = await open();
	await addTodo(todos, 'Milk');
	expectOk(await todos.folder.files.create('notes.txt', 'first'));
	await todos.refresh();
	expect(await todos.rename('notes.txt', 'renamed.txt')).toBeUndefined();
	expect(await text(todos, 'renamed.txt')).toBe('first');
});

test('calls after close began change nothing', async () => {
	const { todos } = await open();
	await todos.close();
	expect(await todos.create('Late')).toBe(
		'Todos is closing, so nothing was changed.',
	);
	expect(await todos.open('todos/x.md', 'todos')).toEqual({
		kind: 'superseded',
	});
	expect(todos.opened).toBeUndefined();
});

test('merge fetches, then merges what was fetched, and pushes nothing', async () => {
	const calls: string[] = [];
	const merged = {
		status: 'merged' as const,
		from: 'a'.repeat(40),
		to: 'c'.repeat(40),
		fetched: 'b'.repeat(40),
		changedPaths: ['kv.json'],
	};
	const { todos } = await open(
		withGit({
			async fetch() {
				calls.push('fetch');
				return Ok({ status: 'fetched', oid: merged.fetched });
			},
			async mergeIncoming() {
				calls.push('mergeIncoming');
				return Ok(merged);
			},
		}),
	);
	expect(expectOk(await todos.merge())).toEqual(merged);
	expect(calls).toEqual(['fetch', 'mergeIncoming']);
});

test('a fetch that answers after close began does not start the fast-forward', async () => {
	let fastForwarded = false;
	let release: (() => void) | undefined;
	const { todos } = await open(
		withGit({
			async fetch(options) {
				await new Promise<void>((resolve) => {
					release = resolve;
					options?.signal?.addEventListener('abort', () => resolve(), {
						once: true,
					});
				});
				return Ok({ status: 'fetched', oid: undefined });
			},
			async pullFastForward() {
				fastForwarded = true;
				return Ok({ status: 'up-to-date' } as never);
			},
		}),
	);
	const pulling = todos.pull();
	while (release === undefined) await Bun.sleep(1);
	const closing = todos.close();
	release();
	expect(expectErr(await pulling).name).toBe('Closed');
	await closing;
	expect(fastForwarded).toBe(false);
});
