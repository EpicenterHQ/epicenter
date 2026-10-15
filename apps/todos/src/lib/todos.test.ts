/**
 * Todos Store Tests
 *
 * Drives the real Todos store and its TanStack Query cache against a real
 * browser folder over an in-memory OPFS stand-in. Views are stood in for as
 * they behave: a screen observes the queries it shows, and an editor holds a
 * draft (`createDraftState`) and saves it with its own save mutation.
 *
 * Key behaviors:
 * - An edit is held by its draft and written to the file; the cache takes
 *   the row the save wrote
 * - Rapid edits run one save at a time; changes made meanwhile are sent
 *   next, from the version the last save wrote, so typing never conflicts
 *   with itself
 * - A change another page made reaches the cache through the folder's
 *   change channel; a read updates the cache, never an edit's draft
 * - A save over a file changed elsewhere merges with it: the edit wins only
 *   where both changed
 * - A save that fails keeps the draft and reports the text it holds; the
 *   folder refuses a value it cannot hold the same way
 * - A row that is not a valid todo is named for repair, and reads as a todo
 *   once another editor fixes it
 * - Delete runs after running saves and acts on what the last one saved; a
 *   file changed elsewhere since the listing read it is refused
 * - Git status names a file with changes in no saved version; saves never
 *   commit, and Save version records one
 * - Close waits for every mutation, and every close call shares one
 *   completion
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { folderOptions } from '@epicenter/folder/query';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
	opfsOf,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from './definition.js';
import { holdCloses } from './opfs-holds.test-support.js';
import {
	cached,
	editorsReady,
	listing,
	observe,
	quiet,
	rowEditor,
	shown,
} from './query.test-support.js';
import type { WriteFailure } from './session.js';
import { repairsOf, todosOf } from './todo-listing.js';
import type { Todos } from './todos.svelte.js';

const { createTodos } = await import('./todos.svelte.ts');
await editorsReady;

const cleanup: (() => unknown)[] = [];
let count = 0;

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * The store over a fresh folder, with its screens observing. `holdNextWrite`
 * holds the next published `.md` write until released, and `mdWrites`
 * counts every published `.md` write.
 */
async function open() {
	const storage = createTestStorage({ BroadcastChannel });
	const id = `todos-test-${count++}`;
	let hold: PromiseWithResolvers<void> | undefined;
	let held: PromiseWithResolvers<void> | undefined;
	const counter = { mdWrites: 0 };
	const folder = expectOk(
		await openFolder({
			id,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				opfs: {
					locks: testLocks,
					BroadcastChannel,
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
		/** Another page of this origin, open on the same folder. */
		async otherPage() {
			const other = expectOk(
				await openFolder({
					id,
					definition: todosDefinition,
					browser: {
						author: { name: 'Other', email: 'other@example.test' },
						...browserStorage(storage),
					},
				}),
			);
			cleanup.push(() => other.close());
			return other;
		},
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

/** Another program writes the file over whatever is there. */
async function writeElsewhere(todos: Todos, path: string, content: string) {
	const { files } = todos.folder;
	const current = await files.read(path);
	if (current.error?.name === 'NotFound')
		return void expectOk(await files.create(path, content));
	expectOk(await files.save(expectOk(current), content, { merge: false }));
}

/** Add a todo through the app; answers its stem and path. */
async function addTodo(todos: Todos, title: string) {
	const created = expectOk(await todos.rows.create(title));
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
// Edits and saves
// ============================================================================

test('an edit is held by its draft and written to the file; the cache takes the row the save wrote', async () => {
	const { todos } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');

	const set = rowEditor(todos, stem);
	set(titled('Oat milk'));
	expect(set.draft.row?.fields.title).toBe('Oat milk');
	await quiet(todos);
	expect(set.draft.row).toBeUndefined();
	expect(await text(todos, path)).toBe(
		'---\ntitle: Oat milk\ndone: false\n---\n',
	);
	expect(cached(todos, stem).row.fields.title).toBe('Oat milk');
	expect(cached(todos, stem).sha256).toBe(await sha(todos, path));
});

test('rapid edits run one save at a time, and the changes made meanwhile are sent next with no conflict', async () => {
	const { todos, counter, failures, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const set = rowEditor(todos, stem);
	const writes = counter.mdWrites;

	const { held, release } = holdNextWrite();
	set(titled('O'));
	await held;
	for (const title of ['Oa', 'Oat', 'Oat ', 'Oat m', 'Oat milk'])
		set(titled(title));
	// One save runs; the draft holds the rest.
	expect(todos.queryClient.isMutating()).toBe(1);
	expect(set.draft.row?.fields.title).toBe('Oat milk');

	release();
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(counter.mdWrites - writes).toBe(2);
	expect(await text(todos, path)).toContain('title: Oat milk');
	expect(cached(todos, stem).sha256).toBe(await sha(todos, path));

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

test('a save of changes made meanwhile still runs while the window is hidden', async () => {
	const { todos, failures, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const set = rowEditor(todos, stem);
	const { held, release } = holdNextWrite();
	set(titled('Oat'));
	await held;
	set(titled('Oat milk'));

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

test("another page's change reaches the cache through the folder's channel, and a read never touches a draft", async () => {
	const { todos, failures, otherPage, failNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const other = await otherPage();

	// Another page marks it done; the listing reads it without a focus.
	const theirs = expectOk(await other.tables.todos.get(stem))!;
	expectOk(
		await other.tables.todos.save(theirs, {
			...theirs.row,
			fields: { ...theirs.row.fields, done: true },
		}),
	);
	for (
		let tries = 0;
		tries < 200 && !cached(todos, stem).row.fields.done;
		tries++
	)
		await Bun.sleep(2);
	expect(cached(todos, stem).row.fields.done).toBe(true);

	// An edit here starts a draft, kept by a save that failed; their next
	// change updates the cache only.
	failNextWrite(path);
	const set = rowEditor(todos, stem);
	set(titled('Oat milk'));
	await quiet(todos);
	expect(failures).toHaveLength(1);
	const next = expectOk(await other.tables.todos.get(stem))!;
	expectOk(
		await other.tables.todos.save(next, {
			...next.row,
			body: 'From the shop.\n',
		}),
	);
	for (
		let tries = 0;
		tries < 200 && cached(todos, stem).row.body === '';
		tries++
	)
		await Bun.sleep(2);
	expect(set.draft.row?.fields.title).toBe('Oat milk');
	expect(set.draft.row?.body).toBe('');
	await set.draft.save();
	await quiet(todos);
	// The save merged: the edit's title, and their notes and completion.
	expect(failures).toHaveLength(1);
	expect(await text(todos, path)).toBe(
		'---\ntitle: Oat milk\ndone: true\n---\nFrom the shop.\n',
	);
});

test('a save that meets a change made elsewhere merges with it: the edit wins only where both changed', async () => {
	const { todos, failures } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const elsewhere = '---\ntitle: Milk from the shop\ndone: true\n---\n';
	await writeElsewhere(todos, path, elsewhere);

	rowEditor(todos, stem)(titled('Oat milk'));
	await quiet(todos);
	expect(failures).toEqual([]);
	// Both changed the title: the edit wins. Only the other side marked it
	// done, so that stays.
	expect(await text(todos, path)).toBe(
		'---\ntitle: Oat milk\ndone: true\n---\n',
	);
	expect(cached(todos, stem).row.fields).toEqual({
		title: 'Oat milk',
		done: true,
	});

	// The next edit starts from what is there now.
	rowEditor(todos, stem)(titled('Oat milk, two'));
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(await text(todos, path)).toBe(
		'---\ntitle: Oat milk, two\ndone: true\n---\n',
	);
});

test('a save that fails keeps the draft and reports its text; the next save sends it', async () => {
	const { todos, failures, failNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const saved = await text(todos, path);
	const set = rowEditor(todos, stem);

	failNextWrite(path);
	set(titled('First'));
	await quiet(todos);
	expect(failures.map((failure) => failure.unsaved)).toEqual([
		expect.stringContaining('title: First'),
	]);
	expect(await text(todos, path)).toBe(saved);
	expect(cached(todos, stem).row.fields.title).toBe('Milk');
	expect(set.draft.row?.fields.title).toBe('First');

	set(titled('Second'));
	await quiet(todos);
	expect(set.draft.row).toBeUndefined();
	expect(await text(todos, path)).toContain('title: Second');
});

test('after a merge, changes made meanwhile keep what the merge took from the other side', async () => {
	const { todos, failures, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	await writeElsewhere(todos, path, '---\ntitle: Milk\ndone: true\n---\n');
	const set = rowEditor(todos, stem);

	const { held, release } = holdNextWrite();
	set(titled('First'));
	await held;
	set(titled('Second'));
	release();
	await quiet(todos);
	expect(failures).toEqual([]);
	// The first save merged in `done`; the second continues from what it
	// wrote, so it does not undo it.
	expect(await text(todos, path)).toBe('---\ntitle: Second\ndone: true\n---\n');
});

test('the folder refuses a value it cannot hold; the cache keeps the file and the draft keeps the edit', async () => {
	const { todos, failures } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const saved = await text(todos, path);
	// Inputs commit only values the schema accepts; this bypasses them.
	const set = rowEditor(todos, stem);
	set(titled('Lone \uD800 surrogate'));
	await quiet(todos);
	expect(failures).toMatchObject([{ path, error: { name: 'InvalidValues' } }]);
	expect(await text(todos, path)).toBe(saved);
	expect(cached(todos, stem).row.fields.title).toBe('Milk');
	expect(set.draft.row?.fields.title).toBe('Lone \uD800 surrogate');
});

// ============================================================================
// Rows that need repair
// ============================================================================

/** Another program writes `text` that does not read as a todo; the folder reports it. */
async function breakTodo(todos: Todos, stem: string, text: string) {
	const path = `todos/${stem}.md`;
	await writeElsewhere(todos, path, text);
	await todos.queryClient.invalidateQueries(
		folderOptions(todos.folder).pathFilter([path]),
	);
	await quiet(todos);
}

test('a row that is not a valid todo is named for repair, and reads as a todo once another editor fixes it', async () => {
	const { todos } = await open();
	const path = 'todos/bad.md';
	await breakTodo(todos, 'bad', '---\ntitle: *missing\n---\n');
	expect(todosOf(listing(todos))).toEqual([]);
	expect(repairsOf(listing(todos))).toEqual([
		{ stem: 'bad', path, reason: expect.any(String) },
	]);
	expect(await text(todos, path)).toBe('---\ntitle: *missing\n---\n');

	await breakTodo(todos, 'bad', '---\ntitle: Bread\ndone: false\n---\n');
	expect(repairsOf(listing(todos))).toEqual([]);
	expect(cached(todos, 'bad').row.fields).toEqual({
		title: 'Bread',
		done: false,
	});
});

// ============================================================================
// Delete
// ============================================================================

test('delete uses the hash the listing read: a file changed elsewhere since is refused', async () => {
	const { todos } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	await writeElsewhere(todos, path, '---\ntitle: Theirs\ndone: false\n---\n');
	expect(
		expectErr(await todos.rows.remove(stem, shown(todos, stem))).name,
	).toBe('Conflict');
	expect(await text(todos, path)).toContain('title: Theirs');

	// A file that does not read as a todo is guarded by its listed hash too.
	await breakTodo(todos, 'bad', 'not a todo');
	await writeElsewhere(todos, 'todos/bad.md', 'changed elsewhere');
	expect(
		expectErr(await todos.rows.remove('bad', shown(todos, 'bad'))).name,
	).toBe('Conflict');
	await todos.refresh();
	await quiet(todos);
	expectOk(await todos.rows.remove('bad', shown(todos, 'bad')));
	expect(await text(todos, 'todos/bad.md')).toBeUndefined();
});

test('a delete runs after running saves and removes only the Markdown file', async () => {
	const { todos, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	expectOk(await todos.folder.files.create('todos/milk.png', 'not a todo'));
	// Typing just before the confirmation opens is written first.
	const { held, release } = holdNextWrite();
	rowEditor(todos, stem)(titled('Oat milk'));
	await held;
	const confirming = todos.rows.shown(stem);
	release();
	const version = await confirming;
	expect(await text(todos, path)).toContain('title: Oat milk\n');
	expectOk(await todos.rows.remove(stem, version!));
	await quiet(todos);
	expect(await text(todos, path)).toBeUndefined();
	expect(todosOf(listing(todos))).toEqual([]);
	expect(await text(todos, 'todos/milk.png')).toBe('not a todo');
});

test('a delete confirmed on a version changed elsewhere since, and read again, deletes nothing', async () => {
	const { todos } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	// The confirmation opens on the version the view shows.
	const confirmedOn = shown(todos, stem);
	await writeElsewhere(todos, path, '---\ntitle: Theirs\ndone: false\n---\n');
	await todos.refresh();
	await quiet(todos);
	expect(cached(todos, stem).row.fields.title).toBe('Theirs');

	expect(expectErr(await todos.rows.remove(stem, confirmedOn))).toMatchObject({
		name: 'NotStarted',
	});
	expect(await text(todos, path)).toContain('title: Theirs');
});

test("the version a delete confirms is the one the app's running save wrote, never the one before it", async () => {
	const { todos, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const before = shown(todos, stem);
	const { held, release } = holdNextWrite();
	rowEditor(todos, stem)(titled('Oat milk'));
	await held;
	const confirming = todos.rows.shown(stem);
	release();
	const version = await confirming;
	expect(version?.sha256).not.toBe(before.sha256);
	expect(version?.sha256).toBe(cached(todos, stem).sha256);
	// A version from before the app's own save is no longer what the file holds.
	expect(expectErr(await todos.rows.remove(stem, before)).name).toBe(
		'NotStarted',
	);
	expectOk(await todos.rows.remove(stem, version!));
	expect(await text(todos, path)).toBeUndefined();
});

test('a delete of a todo the cache no longer holds is refused without reading the folder', async () => {
	const { todos } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const confirmedOn = shown(todos, stem);
	todos.queryClient.setQueryData(todos.rows.todos.queryKey, []);
	expect(expectErr(await todos.rows.remove(stem, confirmedOn))).toMatchObject({
		name: 'NotStarted',
	});
	expect(await text(todos, path)).toContain('title: Milk');
});

// ============================================================================
// Versions
// ============================================================================

test('saves never commit; Save version records one, and Git status names a file with changes in no saved version', async () => {
	const { todos } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	/** Whether status names `path`, as the delete confirmation asks. */
	const unversioned = async () =>
		expectOk(await todos.git.status.fetch()).changes.some(
			(change) => change.path === path,
		);
	rowEditor(todos, stem)(titled('Oat milk'));
	await quiet(todos);
	expect(todos.git.snapshot.lastCommit).toBeUndefined();
	expect(await unversioned()).toBe(true);

	const outcome = expectOk(await todos.git.saveVersion());
	expect(outcome.status).toBe('committed');
	const [head] = expectOk(await todos.folder.git.log(1));
	expect(head?.oid).toBe(outcome.status === 'committed' ? outcome.oid : '');
	expect(await unversioned()).toBe(false);

	rowEditor(todos, stem)(titled('Oat milk, two'));
	await quiet(todos);
	expect(await unversioned()).toBe(true);
});

// ============================================================================
// Closing
// ============================================================================

/** What another page reads at `path`, as after this page closed. */
async function textElsewhere(other: Todos['folder'], path: string) {
	const read = expectOk(await other.files.read(path));
	return new TextDecoder().decode(read.bytes);
}

test('close waits for running saves, and every close call shares one completion', async () => {
	const { todos, holdNextWrite, otherPage } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const { held, release } = holdNextWrite();
	rowEditor(todos, stem)(titled('Oat milk'));
	await held;
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
	// The save finished before the folder closed.
	expect(await textElsewhere(await otherPage(), path)).toContain(
		'title: Oat milk',
	);
});

test('an edit made while close waits is written before the folder closes', async () => {
	const { todos, holdNextWrite, otherPage } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const set = rowEditor(todos, stem);
	const { held, release } = holdNextWrite();
	set(titled('Oat'));
	await held;
	const closing = todos.close();
	// Close is waiting for the held save; the draft sends this edit next.
	set(titled('Oat milk'));
	release();
	await closing;
	expect(todos.folder.signal.aborted).toBe(true);
	expect(set.draft.row).toBeUndefined();
	expect(await textElsewhere(await otherPage(), path)).toContain(
		'title: Oat milk\n',
	);
});
