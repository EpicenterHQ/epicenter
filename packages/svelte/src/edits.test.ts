/**
 * Folder Context Edit Tests
 *
 * Drives a folder's edit handles (`folder.tables.notes.edit(id)`) through
 * `createFolderContext` and the Svelte binding `createRowEdit`, over a real
 * local folder on an in-memory IndexedDB, with the rows query observed as a
 * view observes it. Replacing the folder's `list` holds or fails the
 * context's reread.
 *
 * Key behaviors:
 * - A save lands without waiting for the context's reread; until a read after
 *   it arrives, the binding shows the save over the older row, and typing on
 *   keeps it, also when the reread fails
 * - Every read reaches the view as new values, even when equal to the last
 * - A failed save shows in `saveState` and `failures` until saved
 * - Close refuses input and new actions, lets a started action write after an
 *   await, never waits for a reread, and answers copyable failures
 * - The binding re-runs a reader for its own path and its observed row,
 *   types over what the view last read, lets go of its subscription when no
 *   view reads it, and a reused view follows its path while input stays held
 *
 * See also:
 * - `packages/folder/src/edits.test.ts` for the edit owner's source rules
 */
import './svelte-modules.test-support.js';
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import type { Row } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import type { RowEdit } from '@epicenter/folder/edits';
import { QueryObserver } from '@tanstack/query-core';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';

const { createFolderContext } = await import('./folder-context.js');
const { createRowEdit } = await import('./edits.js');
const { cell, follow } = await import('./reactive.test-support.svelte.js');
const { flushSync } = await import('svelte');

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
type Note = Row<typeof notes>;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const open = async (saveAfterMs?: number) =>
	expectOk(await openFolder({ tables: { notes }, saveAfterMs }));

/** A fresh profile holding `milk`, its context, and the rows a view observes. */
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

/** `edit` with its live subscriptions counted. */
function counted(edit: RowEdit<typeof notes>) {
	let live = 0;
	const wrapped: RowEdit<typeof notes> = {
		path: edit.path,
		get pending() {
			return edit.pending;
		},
		get locked() {
			return edit.locked;
		},
		subscribe(listener) {
			live++;
			const stop = edit.subscribe(listener);
			return () => {
				live--;
				stop();
			};
		},
		shown: (observed) => edit.shown(observed),
		change: (source, change) => edit.change(source, change),
		save: () => edit.save(),
		discard: () => edit.discard(),
		delete: () => edit.delete(),
	};
	return {
		edit: wrapped,
		get live() {
			return live;
		},
	};
}

// ============================================================================
// Saving through the context
// ============================================================================

test('a save lands without waiting for the reread, and the view shows it over the older row until the reread arrives', async () => {
	const { folder, context, milk, cached } = await setup({ saveAfterMs: 60_000 });
	const view = createRowEdit(milk, () => cached());
	const reread = holdReread(folder);
	view.change({ fields: { title: 'Oat milk' } });
	await milk.save();
	await until(() => reread.held > 0);
	expect(milk.pending).toBeUndefined();
	expect(context.saveState).toBe('saved');
	expect(cached().fields.title).toBe('Milk');
	expect(view.row.fields.title).toBe('Oat milk');

	// Typing on, over what the view shows, keeps the save.
	view.change({ fields: { title: `${view.row.fields.title}!` } });
	await milk.save();
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields.title).toBe(
		'Oat milk!',
	);
	reread.release();
	await until(() => cached().fields.title === 'Oat milk!');
	expect(view.row.fields.title).toBe('Oat milk!');
});

test('a failed reread keeps the save shown, and typing over it does not lose it', async () => {
	const { folder, context, observer, milk, cached } = await setup({
		saveAfterMs: 60_000,
	});
	const view = createRowEdit(milk, () => cached());
	const list = folder.tables.notes.list;
	folder.tables.notes.list = async () => {
		throw new Error('Read failed');
	};
	view.change({ fields: { title: 'Buy oat milk' } });
	await milk.save();
	await until(() => observer.getCurrentResult().isError);
	expect(cached().fields.title).toBe('Milk');
	expect(milk.pending).toBeUndefined();
	expect(view.row.fields.title).toBe('Buy oat milk');

	view.change({ fields: { title: `${view.row.fields.title}!` } });
	await milk.save();
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields.title).toBe(
		'Buy oat milk!',
	);
	folder.tables.notes.list = list;
	await observer.refetch();
	expect(cached().fields.title).toBe('Buy oat milk!');
	expect(context.saveState).toBe('saved');
});

test('every read reaches the view as new rows, even when equal to the last', async () => {
	const { observer, cached } = await setup();
	const before = cached();
	await observer.refetch();
	expect(cached()).toEqual(before);
	expect(cached()).not.toBe(before);
});

test('a failed save shows in the save state and failures until save() after recovery saves it', async () => {
	const { context, milk, cached } = await setup();
	const restore = fillDisk();
	milk.change(cached(), { fields: { title: 'Oat milk' } });
	await milk.save();
	expect(milk.pending?.error?.name).toBe('StorageFailed');
	expect(milk.shown(cached()).row.fields.title).toBe('Oat milk');
	expect(context.saveState).toBe('failed');
	expect(context.failures.map(({ path }) => path)).toEqual(['notes/milk.md']);

	restore();
	await milk.save();
	expect(milk.pending).toBeUndefined();
	await until(() => cached().fields.title === 'Oat milk');
	expect(context.saveState).toBe('saved');
});

test('a later malformed source cannot hide a failed save', async () => {
	const { context, milk, cached } = await setup();
	const restore = fillDisk();
	milk.change(cached(), { fields: { title: 'Oat milk' } });
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
	expect(milk.pending).toMatchObject({
		fields: { title: 'Oat milk' },
		error: { name: 'StorageFailed' },
	});
	expect(context.failures.map(({ path }) => path)).toEqual(['notes/milk.md']);
	expect(milk.discard()).toMatchObject({ fields: { title: 'Oat milk' } });
	expect(milk.pending).toBeUndefined();
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
	expect(context.saveState).toBe('recent-failure');
	restore();
	expectOk(await folder.files.write('notes/milk.md', source, source));
	expect(context.saveState).toBe('saved');
});

// ============================================================================
// Close and delete
// ============================================================================

test('close sends typing that waits for its pause and refuses input after it', async () => {
	const { context, milk, cached } = await setup({ saveAfterMs: 60_000 });
	const row = cached();
	milk.change(row, { fields: { title: 'Oat milk' } });
	const closing = context.close();
	expect(context.closing).toBe(true);
	expect(await closing).toEqual([]);
	expect(milk.change(row, { fields: { title: 'Too late' } })).toBe(false);

	const reopened = await open();
	cleanup.push(() => reopened.close());
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields.title).toBe(
		'Oat milk',
	);
});

test('close never waits for a reread that does not answer', async () => {
	const { folder, context, milk, cached } = await setup({ saveAfterMs: 60_000 });
	holdReread(folder);
	milk.change(cached(), { fields: { title: 'Oat milk' } });
	await milk.save();
	milk.change(cached(), { fields: { done: true } });
	expect(await context.close()).toEqual([]);
	const reopened = await open();
	cleanup.push(() => reopened.close());
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields).toEqual({
		title: 'Oat milk',
		done: true,
	});
});

test('an app action is busy but not saving until a write of it is accepted', async () => {
	const { folder, context } = await setup();
	const releaseRequest = Promise.withResolvers<void>();
	const action = context.run(async () => {
		// A request the app waits for: nothing of the folder's is saving.
		await releaseRequest.promise;
		return folder.files.write('action.txt', null, 'done');
	});
	expect(context.busy).toBe(true);
	expect(context.saveState).toBe('saved');
	expect(folder.status.saving).toBe(false);

	// Its write is accepted: the folder says so, and so does the context.
	const states: string[] = [];
	cleanup.push(
		folder.onStatusChange(() => {
			states.push(context.saveState);
		}),
	);
	releaseRequest.resolve();
	expect((await action).error).toBeNull();
	expect(states).toEqual(['saving', 'saved']);
	await until(() => !context.busy);
	expect(context.saveState).toBe('saved');
});

test('close lets a started action write after its await, and refuses a new one', async () => {
	const { folder, context } = await setup();
	const actionStarted = Promise.withResolvers<void>();
	const releaseAction = Promise.withResolvers<void>();
	const action = context.run(async () => {
		actionStarted.resolve();
		await releaseAction.promise;
		return folder.files.write('action.txt', null, 'done');
	});
	await actionStarted.promise;
	const closing = context.close();
	let lateActionStarted = false;
	await expect(
		context.run(async () => {
			lateActionStarted = true;
		}),
	).rejects.toThrow('The folder is closing');
	expect(lateActionStarted).toBe(false);
	expect(context.busy).toBe(true);
	releaseAction.resolve();
	expect((await action).error).toBeNull();
	await closing;
	const reopened = await open();
	cleanup.push(() => reopened.close());
	expect(
		await expectOk(await reopened.files.read('action.txt'))?.content.text(),
	).toBe('done');
});

test('close answers the typing whose save failed, as copyable text', async () => {
	const { context, milk, cached } = await setup({ saveAfterMs: 60_000 });
	fillDisk();
	milk.change(cached(), { body: 'Oat, two litres' });
	const unsaved = await context.close();
	expect(unsaved).toMatchObject([{ path: 'notes/milk.md' }]);
	expect(JSON.parse(unsaved[0]!.unsaved)).toMatchObject({
		body: 'Oat, two litres',
	});
	expect(unsaved[0]?.error?.name).toBe('StorageFailed');
	// The folder still answers it after it closed.
	expect(context.failures).toMatchObject([{ body: 'Oat, two litres' }]);
	expect(milk.pending?.body).toBe('Oat, two litres');
});

test("another handle's committed change is read again", async () => {
	const { cached } = await setup();
	const other = await open();
	cleanup.push(() => other.close());
	const from = expectOk(await other.tables.notes.get('milk'))!;
	expectOk(
		await other.tables.notes.set('milk', from, { fields: { done: true } }),
	);
	await until(() => cached().fields.done === true);
});

// ============================================================================
// The Svelte binding
// ============================================================================

test("a binding re-runs for its own path's typing, its observed row, and close; not another row's typing", async () => {
	const { context, folder, cached } = await setup({ saveAfterMs: 60_000 });
	const shownRow = cell<Note>(cached());
	const milk = createRowEdit(
		folder.tables.notes.edit('milk'),
		() => shownRow.value,
	);
	const bread = createRowEdit(folder.tables.notes.edit('bread'), () => undefined);
	const title = follow(() => milk.row.fields.title);
	const breadPending = follow(() => bread.pending);
	const saveState = follow(() => context.saveState);
	const breadLocked = follow(() => bread.locked);
	cleanup.push(() => {
		for (const { stop } of [title, breadPending, saveState, breadLocked])
			stop();
	});
	flushSync();

	expect(milk.change({ fields: { title: 'Oat milk' } })).toBe(true);
	flushSync();
	shownRow.value = { ...cached(), body: 'Read again' };
	flushSync();
	expect(title.values).toEqual(['Milk', 'Oat milk', 'Oat milk']);
	expect(breadPending.values).toEqual([undefined]);
	expect(saveState.values).toEqual(['saved', 'saving']);
	expect(bread.change({ fields: { title: 'Bread' } })).toBe(false);

	await context.close();
	flushSync();
	expect(breadLocked.values).toEqual([false, true]);
	expect(saveState.values.at(-1)).toBe('saved');
});

test('a binding types over the row its getter answers when the person types', async () => {
	const { folder, cached } = await setup({ saveAfterMs: 60_000 });
	const other = await open();
	cleanup.push(() => other.close());
	const shownRow = cell<Note>(cached());
	const milk = createRowEdit(
		folder.tables.notes.edit('milk'),
		() => shownRow.value,
	);
	milk.change({ fields: { title: 'Oat milk' } });

	// The view now shows an outside change of `done`, and the person types the original back.
	const from = expectOk(await other.tables.notes.get('milk'))!;
	expectOk(
		await other.tables.notes.set('milk', from, { fields: { done: true } }),
	);
	shownRow.value = expectOk(await folder.tables.notes.get('milk'))!;
	expect(milk.row.fields).toEqual({ title: 'Oat milk', done: true });
	milk.change({ fields: { done: false } });
	await milk.save();

	expect(expectOk(await folder.tables.notes.get('milk'))?.fields).toEqual({
		title: 'Oat milk',
		done: false,
	});
});

test('a binding types over what its view last read: older text merges, the held text read again can be reverted', async () => {
	const { folder, cached } = await setup({
		saveAfterMs: 60_000,
		body: 'one\ntwo\nthree\n',
	});
	const edit = folder.tables.notes.edit('milk');
	const row = cached();
	const view = createRowEdit(edit, () => row);
	expect(view.row.body).toBe('one\ntwo\nthree\n');
	// Another view of the same row types first.
	const elsewhere = createRowEdit(edit, () => row);
	expect(elsewhere.row.body).toBe('one\ntwo\nthree\n');
	elsewhere.change({ body: 'ONE\ntwo\nthree\n' });
	// This view has not read again: its typing was over what it showed.
	view.change({ body: 'one\ntwo\nthree typed\n' });
	expect(edit.pending?.body).toBe('ONE\ntwo\nthree typed\n');

	// Read again, it shows the held text, and a revert is a change.
	expect(view.row.body).toBe('ONE\ntwo\nthree typed\n');
	view.change({ body: 'one\ntwo\nthree typed\n' });
	await edit.save();
	expect(expectOk(await folder.tables.notes.get('milk'))?.body).toBe(
		'one\ntwo\nthree typed\n',
	);
});

test('`seen` is what the view showed, and composing from it never moves what a change names', async () => {
	const { folder, cached } = await setup({
		saveAfterMs: 60_000,
		body: 'one\ntwo\n',
	});
	const edit = folder.tables.notes.edit('milk');
	const row = cached();
	const view = createRowEdit(edit, () => row);
	const elsewhere = createRowEdit(edit, () => row);
	expect(view.row.body).toBe('one\ntwo\n');
	expect(elsewhere.row.body).toBe('one\ntwo\n');
	elsewhere.change({ body: 'ONE\ntwo\n' });

	// A command composes from `seen`: still the body this view showed.
	expect(view.seen.body).toBe('one\ntwo\n');
	view.change({ body: view.seen.body.replace('two', 'TWO') });
	expect(edit.pending?.body).toBe('ONE\nTWO\n');
	expect(view.seen.body).toBe('one\ntwo\n');
});

test('a binding no view displays names what it would show now on every command', async () => {
	const { folder, cached } = await setup({ saveAfterMs: 60_000 });
	const edit = folder.tables.notes.edit('milk');
	const row = cached();
	const commands = createRowEdit(edit, () => row);
	commands.change({ fields: { title: 'Oat milk' } });
	expect(commands.seen.fields.title).toBe('Oat milk');
	// The person sees the typed title and turns it back: a revert, not a merge.
	commands.change({ fields: { title: 'Milk' } });
	commands.change({ body: 'Two litres, typed\n' });
	await edit.save();
	expect(expectOk(await folder.tables.notes.get('milk'))).toMatchObject({
		fields: { title: 'Milk', done: false },
		body: 'Two litres, typed\n',
	});
});

test('a view that goes away lets go of its subscription while its input and timer stay with the folder', async () => {
	const { folder, cached } = await setup({ saveAfterMs: 50 });
	const milk = counted(folder.tables.notes.edit('milk'));
	const view = createRowEdit(milk.edit, () => cached());
	const shown = follow(() => view.row.fields.title);
	flushSync();
	expect(milk.live).toBe(1);

	view.change({ fields: { title: 'Oat milk' } });
	flushSync();
	shown.stop();
	flushSync();
	expect(milk.live).toBe(0);
	expect(folder.tables.notes.edit('milk').pending?.fields).toEqual({
		title: 'Oat milk',
	});

	await until(() => folder.tables.notes.edit('milk').pending === undefined);
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields.title).toBe(
		'Oat milk',
	);
});

test('a reused view follows its path, and the row it left keeps its input', async () => {
	const { folder, cached } = await setup({ saveAfterMs: 60_000 });
	expectOk(
		await folder.tables.notes.set('bread', null, {
			fields: { title: 'Bread', done: false },
			body: '',
		}),
	);
	const rows: Record<string, Note> = {
		milk: cached(),
		bread: expectOk(await folder.tables.notes.get('bread'))!,
	};
	const id = cell('milk');
	const live: Record<string, ReturnType<typeof counted>> = {
		milk: counted(folder.tables.notes.edit('milk')),
		bread: counted(folder.tables.notes.edit('bread')),
	};
	let view = createRowEdit(live.milk!.edit, () => rows.milk);
	const shown = follow(() => {
		view = createRowEdit(live[id.value]!.edit, () => rows[id.value]);
		return view.row?.fields.title;
	});
	cleanup.push(shown.stop);
	flushSync();
	view.change({ fields: { title: 'Oat milk' } });
	flushSync();

	id.value = 'bread';
	flushSync();
	view.change({ fields: { title: 'Rye' } });
	flushSync();

	expect(shown.values).toEqual(['Milk', 'Oat milk', 'Bread', 'Rye']);
	expect(live.milk!.live).toBe(0);
	expect(live.bread!.live).toBe(1);
	expect(folder.tables.notes.edit('milk').pending?.fields).toEqual({
		title: 'Oat milk',
	});
});
