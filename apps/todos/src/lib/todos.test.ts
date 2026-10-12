/**
 * Todos Store Tests
 *
 * Drives the real Todos owner and its TanStack Query cache against a real
 * browser folder over an in-memory OPFS stand-in. Views are stood in for as
 * they behave: a screen observes the queries it shows, and an editor edits
 * the cache and queues its own scoped write mutation when `edit` says one
 * is needed.
 *
 * Key behaviors:
 * - An edit changes the cache at once and is written to the file
 * - Rapid edits run one write at a time per file, with one waiting; the
 *   waiting write saves the newest row, guarded by the hash the previous
 *   write confirmed, so typing never conflicts with itself
 * - A read that ran while a write was in flight does not undo the write
 * - A write that fails rolls the cache back to the file, reports the text
 *   that was lost, and a write still waiting saves the file as it was
 * - The folder refuses a value it cannot hold, and the cache rolls back
 * - A row that is not a valid todo is named for repair, its text is
 *   written as typed, and it reads as a todo once repaired
 * - Rename and delete run after the file's queued writes and act on what
 *   the last one saved; edits wait while they run; a file changed elsewhere
 *   since is refused
 * - Delete says when a file has changes in no saved version; saves never
 *   commit, and Save version records one
 * - Close waits for every mutation, and every close call shares one
 *   completion; afterwards edits and actions change nothing
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createTestStorage,
	opfsOf,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from './definition.js';
import { holdCloses } from './opfs-holds.test-support.js';
import {
	cached,
	focusManager,
	listing,
	observe,
	quiet,
	rowEditor,
	textEditor,
} from './query.test-support.js';
import type { Todos, WriteFailure } from './todos.svelte.js';

const { createTodos, repairsOf, todosKeys, todosOf } = await import(
	'./todos.svelte.ts'
);

const cleanup: (() => unknown)[] = [];
let count = 0;

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * The owner over a fresh folder, with its screens observing. `holdNextWrite`
 * holds the next published `.md` write until released, and `mdWrites`
 * counts every published `.md` write.
 */
async function open() {
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
	const failures: WriteFailure[] = [];
	const todos = createTodos(folder, {
		onWriteFailed: (failure) => failures.push(failure),
	});
	cleanup.push(() => todos.close());
	cleanup.push(observe(todos));
	await quiet(todos);
	const faults = opfsOf(storage).faults;
	return {
		todos,
		counter,
		failures,
		holdNextWrite() {
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

async function sha(todos: Todos, path: string) {
	return expectOk(await todos.folder.files.read(path)).sha256;
}

/** Another program writes the file. */
async function writeElsewhere(todos: Todos, path: string, content: string) {
	expectOk(await todos.folder.files.overwrite(path, content));
}

/** Add a todo through the app; answers its stem and path. */
async function addTodo(todos: Todos, title: string) {
	const created = expectOk(await todos.create(title));
	await quiet(todos);
	const stem = created.path.slice('todos/'.length, -'.md'.length);
	return { stem, path: created.path };
}

const titled =
	(title: string) =>
	<T extends { fields: { title: string; done: boolean } }>(row: T): T => ({
		...row,
		fields: { ...row.fields, title },
	});

// ============================================================================
// Edits and writes
// ============================================================================

test('an edit changes the cache at once and is written to the file', async () => {
	const { todos } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	expect(todos.selected).toEqual({ path, as: 'todos' });

	rowEditor(todos, stem)(titled('Oat milk'));
	expect(cached(todos, stem).row.fields.title).toBe('Oat milk');
	await quiet(todos);
	expect(await text(todos, path)).toBe(
		'---\ntitle: Oat milk\ndone: false\n---\n',
	);
	expect(cached(todos, stem).sha256).toBe(await sha(todos, path));
});

test('rapid edits run one write at a time with one waiting, which saves the newest row with no conflict', async () => {
	const { todos, counter, failures, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const set = rowEditor(todos, stem);
	const writes = counter.mdWrites;

	const { held, release } = holdNextWrite();
	set(titled('O'));
	await held;
	for (const title of ['Oa', 'Oat', 'Oat ', 'Oat m', 'Oat milk'])
		set(titled(title));
	// One write runs and one waits; no more were queued.
	expect(
		todos.queryClient.isMutating({ mutationKey: todosKeys.write(path) }),
	).toBe(2);
	expect(cached(todos, stem).row.fields.title).toBe('Oat milk');

	release();
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(counter.mdWrites - writes).toBe(2);
	expect(await text(todos, path)).toContain('title: Oat milk');
	expect(cached(todos, stem).sha256).toBe(await sha(todos, path));

	// The guard moved forward: the next edit writes on top.
	set(titled('Oat milk, two'));
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(await text(todos, path)).toContain('title: Oat milk, two');
});

/** The browser hides the page, as when the person switches tabs. Returns the undo. */
function hideWindow() {
	const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: { visibilityState: 'hidden' },
	});
	return () => {
		if (before) Object.defineProperty(globalThis, 'document', before);
		else Reflect.deleteProperty(globalThis, 'document');
	};
}

test('a write waiting behind another still runs while the window is hidden', async () => {
	const { todos, failures, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const set = rowEditor(todos, stem);
	const { held, release } = holdNextWrite();
	set(titled('Oat'));
	await held;
	set(titled('Oat milk'));

	// The person switches tabs while the second write waits its turn.
	const show = hideWindow();
	try {
		release();
		await quiet(todos);
		expect(await text(todos, path)).toContain('title: Oat milk');
	} finally {
		show();
	}
	expect(failures).toEqual([]);
});

test('no read starts while a write runs: not on returning to the page, not on Check again, not when a view mounts', async () => {
	const { todos, failures, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const stop = observe(todos);
	await quiet(todos);
	const set = rowEditor(todos, stem);

	const { held, release } = holdNextWrite();
	set(titled('Oat milk'));
	await held;
	// Returning to the page while the write is held reads nothing. The page
	// becoming visible is the focus event; the client refetches a tick later.
	focusManager.onFocus();
	await Bun.sleep(0);
	// Neither does Check again.
	void todos.refresh();
	// Neither does a view that mounts now.
	const mounted = observe(todos, path);
	expect(todos.queryClient.isFetching({ queryKey: todosKeys.rows })).toBe(0);
	expect(cached(todos, stem).row.fields.title).toBe('Oat milk');
	release();
	await quiet(todos);
	mounted();
	stop();
	expect(cached(todos, stem).row.fields.title).toBe('Oat milk');
	expect(cached(todos, stem).sha256).toBe(await sha(todos, path));

	set(titled('Oat milk, two'));
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(await text(todos, path)).toContain('title: Oat milk, two');
});

test('a write that meets a change made elsewhere rolls back to the file and reports the lost text', async () => {
	const { todos, failures } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const elsewhere = '---\ntitle: Milk from the shop\ndone: true\n---\n';
	await writeElsewhere(todos, path, elsewhere);

	rowEditor(todos, stem)(titled('Oat milk'));
	await quiet(todos);
	expect(failures).toHaveLength(1);
	expect(failures[0]).toMatchObject({ path, error: { name: 'Conflict' } });
	expect(failures[0]?.lost).toContain('title: Oat milk');
	// The cache shows the file again; nothing was written over it.
	expect(await text(todos, path)).toBe(elsewhere);
	expect(cached(todos, stem).row.fields).toEqual({
		title: 'Milk from the shop',
		done: true,
	});

	// The next edit writes on top of what is there now.
	rowEditor(todos, stem)(titled('Oat milk'));
	await quiet(todos);
	expect(failures).toHaveLength(1);
	expect(await text(todos, path)).toBe(
		'---\ntitle: Oat milk\ndone: true\n---\n',
	);
});

test('a write that fails rolls back, and the write waiting behind it leaves the file as it was', async () => {
	const { todos, failures, failNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const saved = await text(todos, path);
	const set = rowEditor(todos, stem);

	// The first write fails; the second waits behind it.
	failNextWrite(path);
	set(titled('First'));
	set(titled('Second'));
	expect(
		todos.queryClient.isMutating({ mutationKey: todosKeys.write(path) }),
	).toBe(2);
	await quiet(todos);
	// The rollback lands before the waiting write runs, so it saves the
	// file's own row and fails nothing.
	expect(failures.map((failure) => failure.lost)).toEqual([
		expect.stringContaining('title: Second'),
	]);
	expect(await text(todos, path)).toBe(saved);
	expect(cached(todos, stem).row.fields.title).toBe('Milk');
});

test('after a conflict, the write waiting behind it writes nothing over the file found', async () => {
	const { todos, counter, failures } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	// Hand-written: a write of the same row would reformat it.
	const elsewhere = "---\ntitle:   'Milk from the shop'\ndone: true\n---\n";
	await writeElsewhere(todos, path, elsewhere);
	const writes = counter.mdWrites;
	const set = rowEditor(todos, stem);

	set(titled('First'));
	set(titled('Second'));
	expect(
		todos.queryClient.isMutating({ mutationKey: todosKeys.write(path) }),
	).toBe(2);
	await quiet(todos);
	expect(failures).toMatchObject([{ path, error: { name: 'Conflict' } }]);
	expect(counter.mdWrites - writes).toBe(0);
	expect(await text(todos, path)).toBe(elsewhere);
	expect(cached(todos, stem).row.fields.title).toBe('Milk from the shop');

	// The next edit writes again, over the file it now holds.
	set(titled('Third'));
	await quiet(todos);
	expect(await text(todos, path)).toContain('title: Third');
});

test('the folder refuses a value it cannot hold, and the cache rolls back', async () => {
	const { todos, failures } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const saved = await text(todos, path);
	// Inputs commit only values the schema accepts; this bypasses them.
	rowEditor(todos, stem)(titled('Lone \uD800 surrogate'));
	await quiet(todos);
	expect(failures).toMatchObject([{ path, error: { name: 'InvalidValues' } }]);
	expect(await text(todos, path)).toBe(saved);
	expect(cached(todos, stem).row.fields.title).toBe('Milk');
});

test('writes to one todo wait for each other, and writes to different todos do not', async () => {
	const { todos, failures, holdNextWrite } = await open();
	const a = await addTodo(todos, 'A');
	const b = await addTodo(todos, 'B');
	const { held, release } = holdNextWrite();
	rowEditor(todos, a.stem)(titled('A typed'));
	await held;
	rowEditor(todos, a.stem)(titled('A typed again'));
	rowEditor(todos, b.stem)(titled('B typed'));
	const state = (path: string) =>
		todos.queryClient
			.getMutationCache()
			.findAll({ mutationKey: todosKeys.write(path) })
			.map((write) => write.state.isPaused);
	// A's second write waits in A's scope; B's write is not held by A's.
	expect(state(a.path)).toEqual([false, true]);
	expect(state(b.path)).toEqual([false]);
	release();
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(await text(todos, a.path)).toContain('title: A typed again');
	expect(await text(todos, b.path)).toContain('title: B typed');
});

// ============================================================================
// Rows that need repair
// ============================================================================

test('a row that is not a valid todo is named for repair, is written as typed text, and reads as a todo once repaired', async () => {
	const { todos, failures } = await open();
	const path = 'todos/bad.md';
	await writeElsewhere(todos, path, '---\ntitle: *missing\n---\n');
	await todos.queryClient.invalidateQueries({ queryKey: todosKeys.all });
	await quiet(todos);
	expect(todosOf(listing(todos))).toEqual([]);
	expect(repairsOf(listing(todos))).toEqual([
		{ path, reason: expect.any(String) },
	]);

	todos.select(path, 'repair');
	const stop = observe(todos, path);
	cleanup.push(stop);
	await quiet(todos);
	const type = textEditor(todos, path);
	// Text that still does not parse is written as typed.
	type('---\ntitle: Bread\ndone: soon\n---\n');
	await quiet(todos);
	expect(await text(todos, path)).toBe('---\ntitle: Bread\ndone: soon\n---\n');
	expect(repairsOf(listing(todos))).toHaveLength(1);

	type('---\ntitle: Bread\ndone: false\n---\n');
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(repairsOf(listing(todos))).toEqual([]);
	expect(cached(todos, 'bad').row.fields).toEqual({
		title: 'Bread',
		done: false,
	});
});

// ============================================================================
// Rename and delete
// ============================================================================

test('a rename runs after the queued writes and moves what they saved; edits wait while it runs', async () => {
	const { todos, failures, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	expectOk(await todos.folder.files.create('todos/milk.png', 'not a todo'));
	const { held, release } = holdNextWrite();
	rowEditor(todos, stem)(titled('Oat milk'));
	await held;

	const renaming = todos.rename(path, 'oat.md');
	await Bun.sleep(5);
	// The rename waits behind the write, and edits wait behind the rename.
	expect(todos.isMoving(path)).toBe(true);
	expect(todos.edit(stem, titled('Typed during the rename'))).toBe(false);
	release();
	expectOk(await renaming);
	await quiet(todos);

	expect(failures).toEqual([]);
	expect(await text(todos, path)).toBeUndefined();
	expect(await text(todos, 'todos/oat.md')).toContain('title: Oat milk');
	expect(todos.selected).toEqual({ path: 'todos/oat.md', as: 'todos' });
	expect(cached(todos, 'oat').row.fields.title).toBe('Oat milk');
	// Only the Markdown file moved.
	expect(await text(todos, 'todos/milk.png')).toBe('not a todo');

	rowEditor(todos, 'oat')(titled('Oat milk, two'));
	await quiet(todos);
	expect(await text(todos, 'todos/oat.md')).toContain('title: Oat milk, two');
});

test('a todo file keeps its .md extension; another file moves as its bytes', async () => {
	const { todos } = await open();
	const { path } = await addTodo(todos, 'Milk');
	expect(expectErr(await todos.rename(path, 'milk.txt'))).toMatchObject({
		name: 'NotStarted',
		reason: 'A todo file keeps its .md extension.',
	});
	expect(expectErr(await todos.rename(path, 'a/b.md')).name).toBe('NotStarted');
	expectOk(await todos.folder.files.create('notes.txt', 'plain'));
	expectOk(await todos.rename('notes.txt', 'notes.md'));
	expect(await text(todos, 'notes.md')).toBe('plain');
	expect(await text(todos, 'notes.txt')).toBeUndefined();
});

test('a delete runs after the queued writes and removes only the Markdown file', async () => {
	const { todos, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	expectOk(await todos.folder.files.create('todos/milk.png', 'not a todo'));
	const deletion = expectOk(await todos.deletionFor(path));
	expect(deletion).toMatchObject({ kind: 'todo', title: 'Milk' });

	// Typing while the confirmation is open is written first.
	const { held, release } = holdNextWrite();
	rowEditor(todos, stem)(titled('Oat milk'));
	await held;
	const removing = todos.remove(deletion);
	await Bun.sleep(5);
	expect(await text(todos, path)).toContain('title: Milk\n');
	release();
	expectOk(await removing);
	await quiet(todos);
	expect(await text(todos, path)).toBeUndefined();
	expect(todos.selected).toBeUndefined();
	expect(todosOf(listing(todos))).toEqual([]);
	expect(await text(todos, 'todos/milk.png')).toBe('not a todo');
});

test('a delete is refused when the file changed elsewhere after it was confirmed', async () => {
	const { todos } = await open();
	const { path } = await addTodo(todos, 'Milk');
	const deletion = expectOk(await todos.deletionFor(path));
	await writeElsewhere(todos, path, '---\ntitle: Theirs\ndone: false\n---\n');
	expect(expectErr(await todos.remove(deletion)).name).toBe('Conflict');
	expect(await text(todos, path)).toContain('title: Theirs');
});

test('a folder is deleted only when it is empty', async () => {
	const { todos } = await open();
	expectOk(await todos.createFolder({ directory: '', name: 'docs' }));
	expectOk(await todos.createFile({ directory: 'docs', name: 'a.txt' }));
	await quiet(todos);
	expect(todos.selected).toEqual({ path: 'docs/a.txt', as: 'files' });
	expect(expectErr(await todos.deletionFor('docs')).name).toBe('NotStarted');
	expectOk(await todos.remove(expectOk(await todos.deletionFor('docs/a.txt'))));
	await quiet(todos);
	expectOk(await todos.remove(expectOk(await todos.deletionFor('docs'))));
	await quiet(todos);
	const files = todos.queryClient.getQueryData<{ directories: string[] }>(
		todosKeys.files,
	);
	expect(files?.directories).not.toContain('docs');
});

// ============================================================================
// Versions
// ============================================================================

test('saves never commit; Save version records one, and delete says when changes are in no saved version', async () => {
	const { todos } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	rowEditor(todos, stem)(titled('Oat milk'));
	await quiet(todos);
	expect(todos.git.lastCommit).toBeUndefined();
	expect(expectOk(await todos.deletionFor(path))).toMatchObject({
		unversioned: true,
	});

	const outcome = expectOk(await todos.saveVersion());
	expect(outcome.status).toBe('committed');
	const [head] = expectOk(await todos.folder.git.log(1));
	expect(head?.oid).toBe(outcome.status === 'committed' ? outcome.oid : '');
	expect(expectOk(await todos.deletionFor(path))).toMatchObject({
		unversioned: false,
	});

	rowEditor(todos, stem)(titled('Oat milk, two'));
	await quiet(todos);
	expect(expectOk(await todos.deletionFor(path))).toMatchObject({
		unversioned: true,
	});
});

// ============================================================================
// Closing
// ============================================================================

test('close waits for running writes, and every close call shares one completion', async () => {
	const { todos, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const { held, release } = holdNextWrite();
	rowEditor(todos, stem)(titled('Oat milk'));
	await held;
	// Closing empties the cache, so keep the write itself to check after.
	const writes = todos.queryClient
		.getMutationCache()
		.findAll({ mutationKey: todosKeys.write(path) });
	let closed = false;
	const first = todos.close();
	const second = todos.close();
	expect(second).toBe(first);
	void first.then(() => {
		closed = true;
	});
	await Bun.sleep(10);
	expect(closed).toBe(false);
	release();
	await first;
	expect(closed).toBe(true);
	expect(todos.folder.signal.aborted).toBe(true);
	// The write finished before the folder closed.
	expect(writes.map((write) => write.state.status)).toEqual(['success']);
	expect(path).toBe(`todos/${stem}.md`);
});

test('after close begins, edits and actions change nothing', async () => {
	const { todos } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const saved = await text(todos, path);
	void todos.close();
	expect(todos.edit(stem, titled('Late'))).toBe(false);
	expect(cached(todos, stem).row.fields.title).toBe('Milk');
	expect(expectErr(await todos.create('Another')).name).toBe('NotStarted');
	expect(saved).toContain('title: Milk');
});
