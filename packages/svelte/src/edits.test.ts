/**
 * Folder Context Edit Tests
 *
 * Drives a folder's row edits through `createFolderContext` and the Svelte
 * binding `createFileEdit(folder.tables.notes.edit(id))`, over a real local folder
 * on an in-memory IndexedDB, with the rows query observed as a list view
 * observes it. Replacing the folder's `list` holds or fails the context's
 * reread.
 *
 * Key behaviors:
 * - A save lands without waiting for the context's reread, and the binding
 *   shows what storage kept, also when the reread fails; typing on keeps it
 * - A failed save remains in folder status `failures` until saved
 * - Close refuses input and new actions, lets a started action write after an
 *   await, never waits for a reread, and answers copyable failures
 * - The binding reads the row the first time a view shows it, and tells
 *   loading, a missing row and a failed read apart; status-only reads and
 *   commands read nothing
 * - The binding re-runs for its own path only, types over what it shows, lets
 *   go of its subscription when no view reads it, and a reused view follows
 *   its path while input stays held
 *
 * See also:
 * - `packages/folder/src/edits.test.ts` for the edit owner's rules
 */
import { unsavedOf } from './buffer.test-support.js';
import './svelte-modules.test-support.js';
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import type { FolderTable } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import type { FileEdit } from '@epicenter/folder/edits';
import { focusManager, QueryObserver } from '@tanstack/query-core';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';

const { createFolderContext } = await import('./folder-context.js');
const { createFileEdit } = await import('./edits.js');
const { cell, follow } = await import('./reactive.test-support.svelte.js');
const { flushSync } = await import('svelte');

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });

/** Folder status with nothing held, running, or failing in storage. */
const settled = {
	saving: false,
	unsaved: [],
	failures: [],
	storageFailure: null,
};

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const open = async (saveAfterMs?: number) =>
	expectOk(await openFolder({ tables: { notes }, saveAfterMs }));

/** A fresh profile holding `milk`, its context, and the rows a list observes. */
async function setup({ saveAfterMs = 10, body = 'Two litres' } = {}) {
	// The classes `fake-indexeddb/auto` installed, so `fillDisk` patches the
	// store this profile writes through.
	globalThis.indexedDB = new IDBFactory();
	const folder = await open(saveAfterMs);
	expectOk(
		await folder.tables.notes.set('milk', null, {
			fields: { title: 'Milk', done: false },
			body,
		}),
	);
	const context = createFolderContext(folder);
	cleanup.push(() => context.close());
	const observer = new QueryObserver(
		context.queryClient,
		context.queries.rows('notes'),
	);
	cleanup.push(observer.subscribe(() => {}));
	const cached = (id = 'milk') => {
		const row = observer.getCurrentResult().data?.find((row) => row.id === id);
		if (row === undefined) throw new Error(`${id} is not in the cache`);
		return row;
	};
	await until(() => observer.getCurrentResult().data !== undefined);
	return {
		folder,
		context,
		observer,
		milk: folder.tables.notes.edit('milk'),
		cached,
	};
}

async function until(check: () => boolean) {
	for (let tries = 0; tries < 400; tries++) {
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error('Timed out waiting');
}

/** Hold the context's rereads of the notes until `release` is called. */
function holdReread(folder: Awaited<ReturnType<typeof open>>) {
	const list = folder.tables.notes.list;
	const gate = Promise.withResolvers<void>();
	let held = 0;
	folder.tables.notes.list = async () => {
		held++;
		await gate.promise;
		return list();
	};
	cleanup.push(() => gate.resolve());
	return {
		get held() {
			return held;
		},
		release: () => {
			folder.tables.notes.list = list;
			gate.resolve();
		},
	};
}

/** Make every IndexedDB write fail the way a full disk does, until restored. */
function fillDisk() {
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	const restore = () => {
		IDBObjectStore.prototype.put = put;
	};
	cleanup.push(restore);
	return restore;
}

/** Make every IndexedDB read fail, until restored. */
function failReads() {
	const get = IDBObjectStore.prototype.get;
	IDBObjectStore.prototype.get = () => {
		throw new DOMException('The disk is gone', 'UnknownError');
	};
	const restore = () => {
		IDBObjectStore.prototype.get = get;
	};
	cleanup.push(restore);
	return restore;
}

/** `table` with each edit's live subscriptions and reads counted. */
function counted(table: FolderTable<typeof notes>) {
	const live: Record<string, number> = {};
	const reads: Record<string, number> = {};
	const wrapped: FolderTable<typeof notes> = {
		...table,
		edit(id) {
			const edit = table.edit(id);
			return {
				...edit,
				subscribe(listener) {
					live[id] = (live[id] ?? 0) + 1;
					const stop = edit.subscribe(listener);
					return () => {
						live[id] = (live[id] ?? 0) - 1;
						stop();
					};
				},
				read() {
					reads[id] = (reads[id] ?? 0) + 1;
					return edit.read();
				},
			} satisfies FileEdit<typeof notes>;
		},
	};
	return { table: wrapped, live, reads };
}

// ============================================================================
// Saving through the context
// ============================================================================

test('a save lands without waiting for the reread, and the view shows what storage kept', async () => {
	const { folder, context, milk, cached } = await setup({
		saveAfterMs: 60_000,
	});
	const view = createFileEdit(folder.tables.notes.edit('milk'));
	const reread = holdReread(folder);
	view.change({ fields: { title: 'Oat milk' } });
	await milk.save();
	await until(() => reread.held > 0);
	expect(unsavedOf(milk)).toBeUndefined();
	expect(context.getStatus()).toMatchObject(settled);
	expect(cached().fields?.title).toBe('Milk');
	expect(view.markdown?.fields?.title).toBe('Oat milk');

	// Typing on, over what the view shows, keeps the save.
	view.change({ fields: { title: `${view.markdown?.fields?.title}!` } });
	await milk.save();
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields?.title).toBe(
		'Oat milk!',
	);
	reread.release();
	await until(() => cached().fields?.title === 'Oat milk!');
	expect(view.markdown?.fields?.title).toBe('Oat milk!');
});

test('a failed reread keeps the save shown, and typing over it does not lose it', async () => {
	const { folder, context, observer, milk, cached } = await setup({
		saveAfterMs: 60_000,
	});
	const view = createFileEdit(folder.tables.notes.edit('milk'));
	const list = folder.tables.notes.list;
	folder.tables.notes.list = async () => {
		throw new Error('Read failed');
	};
	view.change({ fields: { title: 'Buy oat milk' } });
	await milk.save();
	await until(() => observer.getCurrentResult().isError);
	expect(cached().fields?.title).toBe('Milk');
	expect(unsavedOf(milk)).toBeUndefined();
	expect(view.markdown?.fields?.title).toBe('Buy oat milk');

	view.change({ fields: { title: `${view.markdown?.fields?.title}!` } });
	await milk.save();
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields?.title).toBe(
		'Buy oat milk!',
	);
	folder.tables.notes.list = list;
	await observer.refetch();
	expect(cached().fields?.title).toBe('Buy oat milk!');
	expect(context.getStatus()).toMatchObject(settled);
});

test('a failed save shows in the status and failures until save() after recovery saves it', async () => {
	const { context, milk, cached } = await setup();
	const restore = fillDisk();
	milk.change({ fields: { title: 'Oat milk' } });
	await milk.save();
	expect(unsavedOf(milk)?.error?.name).toBe('StorageFailed');
	expect(milk.getMarkdown()?.fields?.title).toBe('Oat milk');
	expect(context.getStatus()).toMatchObject({
		saving: false,
		unsaved: ['notes/milk.md'],
		storageFailure: { name: 'StorageFailed' },
	});
	expect(context.getStatus().failures.map(({ path }) => path)).toEqual([
		'notes/milk.md',
	]);

	restore();
	await milk.save();
	expect(unsavedOf(milk)).toBeUndefined();
	await until(() => cached().fields?.title === 'Oat milk');
	expect(context.getStatus()).toMatchObject(settled);
});

test('a later malformed source cannot hide a failed save', async () => {
	const { context, milk, cached } = await setup();
	const restore = fillDisk();
	milk.change({ fields: { title: 'Oat milk' } });
	await milk.save();
	restore();
	const other = await open();
	cleanup.push(() => other.close());
	const before = expectOk(await other.files.read('notes/milk.md'))!;
	expectOk(
		await other.files.write(
			'notes/milk.md',
			await before.content.text(),
			'---\ntitle: [broken\n---\n',
		),
	);
	await until(() => cached().issues !== null);
	expect(milk.getText()).toContain('title: Oat milk');
	expect(unsavedOf(milk)?.error?.name).toBe('StorageFailed');
	expect(context.getStatus().failures.map(({ path }) => path)).toEqual([
		'notes/milk.md',
	]);
	await milk.save();
	expect(expectOk(milk.discard())?.text).toContain('title: Oat milk');
	expect(unsavedOf(milk)).toBeUndefined();
});

test('a storage failure without held input is reported as a past failure', async () => {
	const { folder, context } = await setup();
	const restore = fillDisk();
	const before = expectOk(await folder.files.read('notes/milk.md'))!;
	const source = await before.content.text();
	expect(
		(
			await folder.files.write(
				'notes/milk.md',
				source,
				source.replace('Milk', 'Oat milk'),
			)
		).error?.name,
	).toBe('StorageFailed');
	expect(context.getStatus()).toMatchObject({
		saving: false,
		unsaved: [],
		failures: [],
		storageFailure: { name: 'StorageFailed' },
	});
	restore();
	expectOk(await folder.files.write('notes/milk.md', source, source));
	expect(context.getStatus()).toMatchObject(settled);
});

// ============================================================================
// Close and delete
// ============================================================================

test('close sends typing that waits for its pause and refuses input after it', async () => {
	const { context, milk } = await setup({ saveAfterMs: 60_000 });
	milk.change({ fields: { title: 'Oat milk' } });
	const closing = context.close();
	expect(context.closing).toBe(true);
	expect(await closing).toEqual([]);
	expectErr(milk.change({ fields: { title: 'Too late' } }));

	const reopened = await open();
	cleanup.push(() => reopened.close());
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields?.title).toBe(
		'Oat milk',
	);
});

test('close never waits for a reread that does not answer', async () => {
	const { folder, context, milk } = await setup({ saveAfterMs: 60_000 });
	holdReread(folder);
	milk.change({ fields: { title: 'Oat milk' } });
	await milk.save();
	milk.change({ fields: { done: true } });
	expect(await context.close()).toEqual([]);
	const reopened = await open();
	cleanup.push(() => reopened.close());
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields).toEqual({
		title: 'Oat milk',
		done: true,
	});
});

test('an app action does not enter Folder save status until its write is accepted', async () => {
	const { folder, context } = await setup();
	const releaseRequest = Promise.withResolvers<void>();
	const action = folder.run([], async () => {
		// A request the app waits for: nothing of the folder's is saving.
		await releaseRequest.promise;
		return folder.files.write('action.txt', null, 'done');
	});
	expect(context.getStatus()).toMatchObject(settled);

	// Its write is accepted: the folder says so, and so does the context.
	const saving: boolean[] = [];
	cleanup.push(
		folder.onStatusChange(() => {
			saving.push(context.getStatus().saving);
		}),
	);
	releaseRequest.resolve();
	expectOk(expectOk(await action));
	expect(saving).toEqual([true, false]);
	expect(context.getStatus()).toMatchObject(settled);
});

test('close lets a started action write after its await, and refuses a new one', async () => {
	const { folder, context, observer } = await setup();
	const fileEdit = createFileEdit(folder.tables.notes.edit('milk'));
	expectOk(fileEdit.change({ body: 'Accepted before closing' }));
	const actionStarted = Promise.withResolvers<void>();
	const releaseAction = Promise.withResolvers<void>();
	const action = folder.run(['action.txt'], async () => {
		actionStarted.resolve();
		await releaseAction.promise;
		return folder.files.write('action.txt', null, 'done');
	});
	await actionStarted.promise;
	const closing = context.close();
	// Folder close fences every editor immediately. Work admitted earlier
	// still writes through the folder after an await.
	expect(fileEdit.locked).toBe(true);
	expect(folder.getStatus().closing).toBe(true);
	expect(expectErr(fileEdit.replaceText('Late source')).name).toBe('Locked');
	expect(
		expectErr(folder.tables.notes.edit('milk').change({ body: 'Late body' }))
			.name,
	).toBe('Locked');
	expect(fileEdit.markdown?.body).toBe('Accepted before closing');
	// A visibility return during the drain must not reread the closing folder.
	cleanup.push(() => focusManager.setFocused(undefined));
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	await Bun.sleep(0);
	expect(observer.getCurrentResult().error).toBeNull();
	let lateActionStarted = false;
	expectErr(
		await folder.run([], async () => {
			lateActionStarted = true;
		}),
	);
	expect(lateActionStarted).toBe(false);
	releaseAction.resolve();
	expectOk(expectOk(await action));
	await closing;
	const reopened = await open();
	cleanup.push(() => reopened.close());
	expect(
		await expectOk(await reopened.files.read('action.txt'))?.content.text(),
	).toBe('done');
	expect(expectOk(await reopened.tables.notes.get('milk'))?.body).toBe(
		'Accepted before closing',
	);
});

test('close answers the typing whose save failed, as copyable text', async () => {
	const { context, milk } = await setup({ saveAfterMs: 60_000 });
	fillDisk();
	milk.change({ body: 'Oat, two litres' });
	const unsaved = await context.close();
	expect(unsaved).toMatchObject([{ path: 'notes/milk.md' }]);
	expect(unsaved[0]!.unsaved).toContain('Oat, two litres');
	expect(unsaved[0]?.error?.name).toBe('StorageFailed');
	// The folder still answers it after it closed.
	expect(context.getStatus().failures[0]?.text).toBe(unsaved[0]!.unsaved);
	expect(milk.getText()).toBe(unsaved[0]!.unsaved);
});

test("another handle's committed change is read again, by the list and the view showing it", async () => {
	const { folder, cached } = await setup();
	const view = createFileEdit(folder.tables.notes.edit('milk'));
	const done = follow(() => view.markdown?.fields?.done);
	cleanup.push(done.stop);
	flushSync();
	const other = await open();
	cleanup.push(() => other.close());
	const from = expectOk(await other.tables.notes.get('milk'))!;
	expectOk(
		await other.tables.notes.set('milk', from, { fields: { done: true } }),
	);
	await until(() => cached().fields?.done === true);
	await until(() => view.markdown?.fields?.done === true);
	flushSync();
	expect(done.values.at(-1)).toBe(true);
});

// ============================================================================
// The Svelte binding
// ============================================================================

test('a binding reads the row the first time a view shows it, and tells loading, missing and a failed read apart', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = await open(60_000);
	cleanup.push(() => folder.close());
	expectOk(
		await folder.tables.notes.set('milk', null, {
			fields: { title: 'Milk', done: false },
		}),
	);
	// A set answers the row it sent; no edit holds the document yet.
	const notesTable = counted(folder.tables.notes);
	const milk = createFileEdit(notesTable.table.edit('milk'));
	const ghost = createFileEdit(notesTable.table.edit('ghost'));
	// Creating bindings and reading their status reads nothing.
	expect(milk.buffer.status).toBe('unread');
	expect(milk.locked).toBe(false);
	expect(notesTable.reads).toEqual({});

	const shown = follow(
		() => [milk.buffer.status, milk.markdown?.fields?.title] as const,
	);
	const missing = follow(() => ghost.buffer);
	cleanup.push(shown.stop, missing.stop);
	flushSync();
	expect(shown.values[0]).toEqual(['loading', undefined]);
	expect(milk.buffer.status).toBe('loading');
	await until(
		() => milk.markdown !== undefined && ghost.buffer.status !== 'loading',
	);
	flushSync();
	expect(shown.values.at(-1)).toEqual(['ready', 'Milk']);
	expect(missing.values.at(-1)).toMatchObject({
		status: 'unavailable',
		error: { name: 'SourceUnavailable', reason: 'missing' },
	});
	expect(notesTable.reads).toEqual({ milk: 1, ghost: 1 });

	// A failed read is not a missing row; a failed reread keeps the row. Every
	// view of the row sees the same status.
	const restore = failReads();
	const other = createFileEdit(folder.tables.notes.edit('milk'));
	expect(expectErr(await ghost.read()).name).toBe('StorageFailed');
	expect(expectErr(await milk.read()).name).toBe('StorageFailed');
	flushSync();
	expect(missing.values.at(-1)).toMatchObject({
		status: 'unavailable',
		error: { name: 'StorageFailed' },
	});
	expect(milk.buffer.error?.name).toBe('StorageFailed');
	expect(other.buffer).toBe(milk.buffer);
	expect(milk.markdown?.fields?.title).toBe('Milk');
	restore();
	expectOk(await milk.read());
	expect(milk.buffer.error).toBeUndefined();
});

test('observing an unread buffer starts its read after a prior input refusal', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = await open(60_000);
	cleanup.push(() => folder.close());
	expectOk(
		await folder.tables.notes.set('milk', null, {
			fields: { title: 'Milk', done: false },
		}),
	);
	const notesTable = counted(folder.tables.notes);
	const view = createFileEdit(notesTable.table.edit('milk'));
	expect(expectErr(view.replaceText('too early')).name).toBe('NoSource');
	expect(view.buffer.status).toBe('unread');
	expect(view.buffer.error?.name).toBe('NoSource');
	expect(notesTable.reads).toEqual({});
	const shown = follow(() => view.buffer);
	cleanup.push(shown.stop);
	flushSync();
	await until(() => view.buffer.status === 'ready');
	flushSync();
	expect(view.buffer.error).toBeUndefined();
	expect(view.text).toContain('title: Milk');
	expect(notesTable.reads).toEqual({ milk: 1 });
});

test('observing a buffer during an explicit first read starts no second read', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = await open(60_000);
	cleanup.push(() => folder.close());
	expectOk(
		await folder.tables.notes.set('milk', null, {
			fields: { title: 'Milk', done: false },
		}),
	);
	const notesTable = counted(folder.tables.notes);
	const core = notesTable.table.edit('milk');
	const reading = core.read();
	const view = createFileEdit(core);
	const shown = follow(() => view.buffer);
	cleanup.push(shown.stop);
	flushSync();
	expect(notesTable.reads).toEqual({ milk: 1 });
	expectOk(await reading);
	flushSync();
	expect(view.buffer.status).toBe('ready');
	expect(notesTable.reads).toEqual({ milk: 1 });
});

test('a failed first read waits for an explicit read: showing the edit again reads nothing', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = await open(60_000);
	cleanup.push(() => folder.close());
	expectOk(
		await folder.tables.notes.set('milk', null, {
			fields: { title: 'Milk', done: false },
		}),
	);
	const notesTable = counted(folder.tables.notes);
	const restore = failReads();
	const first = follow(
		() => createFileEdit(notesTable.table.edit('milk')).buffer,
	);
	flushSync();
	await until(
		() => folder.tables.notes.edit('milk').getBuffer().status !== 'loading',
	);
	flushSync();
	expect(first.values.at(-1)).toMatchObject({
		status: 'unavailable',
		error: { name: 'StorageFailed' },
	});
	first.stop();
	// Shown again, by a new edit in a new view: the failure stays until a read is asked for.
	const again = follow(
		() => createFileEdit(notesTable.table.edit('milk')).buffer,
	);
	cleanup.push(again.stop);
	flushSync();
	await Bun.sleep(30);
	flushSync();
	expect(notesTable.reads).toEqual({ milk: 1 });
	expect(again.values.at(-1)?.error?.name).toBe('StorageFailed');

	restore();
	const view = createFileEdit(notesTable.table.edit('milk'));
	expectOk(await view.read());
	expect(view.markdown?.fields?.title).toBe('Milk');
	flushSync();
	expect(again.values.at(-1)).toMatchObject({
		status: 'ready',
		error: undefined,
	});
});

test("a binding re-runs for its own path's typing, its document, and close; not another row's typing", async () => {
	const { context, folder } = await setup({ saveAfterMs: 60_000 });
	const notesTable = counted(folder.tables.notes);
	const milk = createFileEdit(notesTable.table.edit('milk'));
	const bread = createFileEdit(notesTable.table.edit('bread'));
	const title = follow(() => milk.markdown?.fields?.title);
	const unsaved = follow(() => context.getStatus().unsaved);
	const breadLocked = follow(() => bread.locked);
	cleanup.push(() => {
		for (const { stop } of [title, unsaved, breadLocked]) stop();
	});
	flushSync();

	expectOk(milk.change({ fields: { title: 'Oat milk' } }));
	flushSync();
	expect(title.values).toEqual(['Milk', 'Oat milk']);
	expect(breadLocked.values).toEqual([false]);
	expect(unsaved.values).toEqual([[], ['notes/milk.md']]);
	expectErr(bread.change({ fields: { title: 'Bread' } }));
	// The list answered milk, and bread is read only for its status.
	expect(notesTable.reads).toEqual({});

	await context.close();
	flushSync();
	expect(breadLocked.values.at(-1)).toBe(true);
	expect(unsaved.values.at(-1)).toEqual([]);
});

test('a binding pins what it shows and reports an outside change as conflict', async () => {
	const { folder } = await setup({ saveAfterMs: 60_000 });
	const other = await open();
	cleanup.push(() => other.close());
	const milk = createFileEdit(folder.tables.notes.edit('milk'));
	expectOk(milk.change({ fields: { title: 'Oat milk' } }));

	// The outside change updates storage while the local source remains pinned.
	const from = expectOk(await other.tables.notes.get('milk'))!;
	expectOk(
		await other.tables.notes.set('milk', from, { fields: { done: true } }),
	);
	expectOk(await milk.read());
	expect(milk.markdown?.fields).toEqual({ title: 'Oat milk', done: false });
	expectOk(milk.change({ fields: { done: false } }));
	expect(expectErr(await milk.save()).name).toBe('Conflict');
	expect(milk.buffer).toMatchObject({
		status: 'ready',
		unsaved: { status: 'conflict' },
	});
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields?.done).toBe(
		true,
	);
});

test('two bindings of one row compose over current held input', async () => {
	const { folder } = await setup({ saveAfterMs: 60_000, body: 'one\ntwo\n' });
	const view = createFileEdit(folder.tables.notes.edit('milk'));
	const elsewhere = createFileEdit(folder.tables.notes.edit('milk'));
	expect(view.markdown?.body).toBe('one\ntwo\n');
	expectOk(elsewhere.change({ body: 'ONE\ntwo\n' }));
	expect(view.markdown?.body).toBe('ONE\ntwo\n');
	expectOk(
		view.change({ body: (view.markdown?.body ?? '').replace('two', 'TWO') }),
	);
	expect(view.markdown?.body).toBe('ONE\nTWO\n');
	await view.save();
	expect(expectOk(await folder.tables.notes.get('milk'))?.body).toBe(
		'ONE\nTWO\n',
	);
});

test('Svelte text, markdown and buffer track one pinned source through conflict recovery', async () => {
	const { folder } = await setup({ saveAfterMs: 60_000 });
	const other = await open();
	cleanup.push(() => other.close());
	const row = createFileEdit(folder.tables.notes.edit('milk'));
	const source = createFileEdit(folder.files.edit('notes/milk.md'));
	const buffer = follow(() => row.buffer);
	const text = follow(() => source.text);
	const title = follow(() => row.markdown?.fields?.title);
	cleanup.push(() => {
		buffer.stop();
		text.stop();
		title.stop();
	});
	flushSync();
	expectOk(row.change({ fields: { title: 'Local' } }));
	flushSync();
	expect(buffer.values.at(-1)).toMatchObject({
		status: 'ready',
		text: text.values.at(-1),
		unsaved: { status: 'dirty' },
	});
	expect(title.values.at(-1)).toBe('Local');
	const draft = source.text;
	const current = expectOk(await other.tables.notes.get('milk'))!;
	expectOk(await other.tables.notes.set('milk', current, { body: 'Outside' }));
	const saved = expectOk(await other.tables.notes.get('milk'))!.text;
	expectOk(await row.read());
	flushSync();
	expect(source.text).toBe(draft);
	expect(row.text).toBe(draft);
	expect(expectErr(await row.save()).name).toBe('Conflict');
	flushSync();
	expect(buffer.values.at(-1)).toMatchObject({
		status: 'ready',
		text: draft,
		unsaved: { status: 'conflict', error: { name: 'Conflict' } },
	});
	expect(source.text).toBe(draft);
	expect(expectOk(await other.tables.notes.get('milk'))!.text).toBe(saved);
	expectOk(await row.resolveConflict('current'));
	flushSync();
	expect(buffer.values.at(-1)).toMatchObject({
		status: 'ready',
		text: saved,
		unsaved: undefined,
	});
	expect(title.values.at(-1)).toBe('Milk');
	expect(text.values.at(-1)).toBe(saved);
	expect(row.markdown?.body).toBe('Outside');
});

test('a binding used without a view types over current input on every command', async () => {
	const { folder } = await setup({ saveAfterMs: 60_000 });
	const commands = createFileEdit(folder.tables.notes.edit('milk'));
	commands.change({ fields: { title: 'Oat milk' } });
	expect(commands.markdown?.fields?.title).toBe('Oat milk');
	// The person sees the typed title and turns it back: a revert, not a merge.
	commands.change({ fields: { title: 'Milk' } });
	commands.change({ body: 'Two litres, typed\n' });
	await commands.save();
	expect(expectOk(await folder.tables.notes.get('milk'))).toMatchObject({
		fields: { title: 'Milk', done: false },
		body: 'Two litres, typed\n',
	});
});

test('a row deleted elsewhere leaves its dirty source editable and reports conflict', async () => {
	const { folder } = await setup({ saveAfterMs: 60_000 });
	const view = createFileEdit(folder.tables.notes.edit('milk'));
	expectOk(view.change({ body: 'Keep this input' }));
	const draft = view.text;
	const other = await open();
	cleanup.push(() => other.close());
	const from = expectOk(await other.tables.notes.get('milk'))!;
	expectOk(await other.tables.notes.delete('milk', from));
	expectOk(await view.read());
	expect(view.markdown?.body).toBe('Keep this input');
	expect(view.text).toBe(draft);
	expectOk(view.change({ body: 'Still typing' }));
	expect(expectErr(await view.save()).name).toBe('Conflict');
	expect(view.buffer).toMatchObject({
		status: 'ready',
		unsaved: { status: 'conflict' },
	});
	expect(view.text).toContain('Still typing');
	expect(expectOk(await other.tables.notes.get('milk'))).toBeUndefined();
	expectOk(await view.resolveConflict('draft'));
	expect(expectOk(await other.tables.notes.get('milk'))?.text).toBe(view.text);
	expect(view.buffer).toMatchObject({ status: 'ready', unsaved: undefined });
});

test('a view that goes away lets go of its subscription while its input and timer stay with the folder', async () => {
	const { folder } = await setup({ saveAfterMs: 50 });
	const notesTable = counted(folder.tables.notes);
	const view = createFileEdit(notesTable.table.edit('milk'));
	const shown = follow(() => view.markdown?.fields?.title);
	flushSync();
	expect(notesTable.live.milk).toBe(1);

	view.change({ fields: { title: 'Oat milk' } });
	flushSync();
	shown.stop();
	flushSync();
	await Promise.resolve();
	expect(notesTable.live.milk).toBe(0);
	expect(folder.tables.notes.edit('milk').getText()).toContain(
		'title: Oat milk',
	);

	await until(() => {
		const pending = unsavedOf(folder.tables.notes.edit('milk'));
		return pending === undefined || pending.error !== undefined;
	});
	expect(unsavedOf(folder.tables.notes.edit('milk'))?.error).toBeUndefined();
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields?.title).toBe(
		'Oat milk',
	);
});

test('a reused view follows its path, and the row it left keeps its input', async () => {
	const { folder } = await setup({ saveAfterMs: 60_000 });
	expectOk(
		await folder.tables.notes.set('bread', null, {
			fields: { title: 'Bread', done: false },
			body: '',
		}),
	);
	expectOk(await folder.tables.notes.list());
	const notesTable = counted(folder.tables.notes);
	const id = cell('milk');
	let view = createFileEdit(notesTable.table.edit('milk'));
	const shown = follow(() => {
		view = createFileEdit(notesTable.table.edit(id.value));
		return view.markdown?.fields?.title;
	});
	cleanup.push(shown.stop);
	flushSync();
	view.change({ fields: { title: 'Oat milk' } });
	flushSync();

	id.value = 'bread';
	flushSync();
	view.change({ fields: { title: 'Rye' } });
	flushSync();
	await Promise.resolve();

	expect(shown.values).toEqual(['Milk', 'Oat milk', 'Bread', 'Rye']);
	expect(notesTable.live.milk).toBe(0);
	expect(notesTable.live.bread).toBe(1);
	expect(folder.tables.notes.edit('milk').getText()).toContain(
		'title: Oat milk',
	);
});
