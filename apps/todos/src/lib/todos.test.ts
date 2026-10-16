/**
 * Todos Store Tests
 *
 * Drives the real Todos store and its TanStack Query cache against a real
 * browser folder over an in-memory OPFS stand-in. Views are stood in for as
 * they behave: a screen observes the queries it shows, and a control sends
 * each change through its own update mutation (ADR-0554).
 *
 * Key behaviors:
 * - An update is written to the file; the cache takes the row it wrote
 * - One todo's updates run one at a time, in the order made, each over the
 *   file the last one wrote, so a checkbox never undoes a title, and they
 *   run while the window is hidden
 * - A change another page made reaches the cache through the folder's
 *   change channel, and an update keeps it: the update sets only its fields
 * - An update over a file changed elsewhere keeps every field it did not set
 * - An update that fails is reported and writes nothing; the folder refuses
 *   a value it cannot hold the same way
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

/** A title box's update. */
const titled = (title: string) => ({ title });
/** A checkbox's update. */
const marked = (done: boolean) => ({ done });

// ============================================================================
// Edits and saves
// ============================================================================

test('an update is written to the file; the cache takes the row it wrote', async () => {
	const { todos, failures } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');

	rowEditor(todos, stem)(titled('Oat milk'));
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(await text(todos, path)).toBe(
		'---\ntitle: Oat milk\ndone: false\n---\n',
	);
	expect(cached(todos, stem).row.fields.title).toBe('Oat milk');
	expect(cached(todos, stem).sha256).toBe(await sha(todos, path));
});

test("one todo's updates run one at a time in the order made, so a checkbox does not undo a title", async () => {
	const { todos, counter, failures, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const title = rowEditor(todos, stem);
	const done = rowEditor(todos, stem);
	const writes = counter.mdWrites;

	const { held, release } = holdNextWrite();
	void title(titled('Oat milk'));
	await held;
	void done(marked(true));
	// The checkbox's update waits for the title's to land.
	expect(todos.queryClient.isMutating()).toBe(2);
	expect(counter.mdWrites - writes).toBe(1);

	release();
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(counter.mdWrites - writes).toBe(2);
	expect(await text(todos, path)).toBe(
		'---\ntitle: Oat milk\ndone: true\n---\n',
	);
	expect(cached(todos, stem).sha256).toBe(await sha(todos, path));
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

test('an update waiting for the one before still runs while the window is hidden', async () => {
	const { todos, failures, holdNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const { held, release } = holdNextWrite();
	void rowEditor(todos, stem)(titled('Oat'));
	await held;
	void rowEditor(todos, stem)(titled('Oat milk'));

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

test("another page's change reaches the cache through the folder's channel, and an update keeps it", async () => {
	const { todos, failures, otherPage } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const other = await otherPage();

	// Another page marks it done and adds notes; the listing reads it
	// without a focus.
	const theirs = expectOk(await other.tables.todos.get(stem))!;
	expectOk(
		await other.tables.todos.save(theirs, {
			fields: { ...theirs.row.fields, done: true },
			body: 'From the shop.\n',
		}),
	);
	for (
		let tries = 0;
		tries < 200 && !cached(todos, stem).row.fields.done;
		tries++
	)
		await Bun.sleep(2);
	expect(cached(todos, stem).row.fields.done).toBe(true);

	await rowEditor(todos, stem)(titled('Oat milk'));
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(await text(todos, path)).toBe(
		'---\ntitle: Oat milk\ndone: true\n---\nFrom the shop.\n',
	);
});

test('an update over a file changed elsewhere sets only its own field', async () => {
	const { todos, failures } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	// The cache still holds the version from before this change.
	const elsewhere = '---\ntitle: Milk from the shop\ndone: true\n---\n';
	await writeElsewhere(todos, path, elsewhere);

	rowEditor(todos, stem)(titled('Oat milk'));
	await quiet(todos);
	expect(failures).toEqual([]);
	// Both changed the title: the update wins. Only the other side marked it
	// done, so that stays.
	expect(await text(todos, path)).toBe(
		'---\ntitle: Oat milk\ndone: true\n---\n',
	);
	expect(cached(todos, stem).row.fields).toEqual({
		title: 'Oat milk',
		done: true,
	});
});

test('an update that fails is reported and writes nothing; the next one sends', async () => {
	const { todos, failures, failNextWrite } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const saved = await text(todos, path);
	const set = rowEditor(todos, stem);

	failNextWrite(path);
	await set(titled('First'));
	await quiet(todos);
	expect(failures).toMatchObject([{ path, unsaved: '' }]);
	expect(await text(todos, path)).toBe(saved);
	expect(cached(todos, stem).row.fields.title).toBe('Milk');

	await set(titled('Second'));
	await quiet(todos);
	expect(await text(todos, path)).toContain('title: Second');
});

test('the folder refuses a value the schema does not accept; the cache keeps the file', async () => {
	const { todos, failures } = await open();
	const { stem, path } = await addTodo(todos, 'Milk');
	const saved = await text(todos, path);
	// Inputs commit only values the schema accepts; this bypasses them.
	rowEditor(todos, stem)({ done: 'yes' as unknown as boolean });
	await quiet(todos);
	expect(failures).toMatchObject([{ path, error: { name: 'InvalidValues' } }]);
	expect(await text(todos, path)).toBe(saved);
	expect(cached(todos, stem).row.fields.done).toBe(false);
});

test('half a character typed into a title is saved as U+FFFD (ADR-0570)', async () => {
	const { todos, failures } = await open();
	const { stem } = await addTodo(todos, 'Milk');
	rowEditor(todos, stem)(titled('Lone \uD800 surrogate'));
	await quiet(todos);
	expect(failures).toEqual([]);
	expect(cached(todos, stem).row.fields.title).toBe('Lone � surrogate');
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
	void set(titled('Oat'));
	await held;
	const closing = todos.close();
	// Close is waiting for the held update; this one runs after it.
	void set(titled('Oat milk'));
	release();
	await closing;
	expect(todos.folder.signal.aborted).toBe(true);
	expect(await textElsewhere(await otherPage(), path)).toContain(
		'title: Oat milk\n',
	);
});
