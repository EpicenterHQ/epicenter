/**
 * Local Edits Tests
 *
 * Drives the edit layer of `createFolderContext` over a real local
 * folder (`openFolder({ tables })`) on an in-memory IndexedDB, with the rows
 * query observed as a view observes it. A save is held open by wrapping the
 * table's `set`, so a reread can land while it runs.
 *
 * Key behaviors:
 * - A reread, including one while the save runs, never replaces the typing
 * - Typing during a running save stays held and saves after it
 * - A failed save keeps the typing and its error; `save()` tries again
 * - Close sends typing still waiting for its pause, refuses new input, and
 *   answers the drafts that did not save
 * - Delete waits for the running save, then deletes the row and its typing
 * - Another handle's committed change marks the rows stale and is read again
 */
import './svelte-modules.test-support.js';
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { QueryObserver } from '@tanstack/query-core';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';

const { createFolderContext } = await import('./folder-context.js');

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const open = async () => expectOk(await openFolder({ tables: { notes } }));

/** A fresh profile holding `milk`, its context, and the rows a view observes. */
async function setup({ saveAfterMs = 10 } = {}) {
	// The classes `fake-indexeddb/auto` installed, so `fillDisk` patches the
	// store this profile writes through.
	globalThis.indexedDB = new IDBFactory();
	const folder = await open();
	expectOk(
		await folder.tables.notes.set('milk', null, {
			fields: { title: 'Milk', done: false },
			body: 'Two litres',
		}),
	);
	const context = createFolderContext(folder, { saveAfterMs });
	cleanup.push(() => context.close());
	const observer = new QueryObserver(
		context.queryClient,
		context.queries.rows('notes'),
	);
	cleanup.push(observer.subscribe(() => {}));
	const cached = () => {
		const row = observer
			.getCurrentResult()
			.data?.find((row) => row.id === 'milk');
		if (row === undefined) throw new Error('milk is not in the cache');
		return row;
	};
	await until(() => observer.getCurrentResult().data !== undefined);
	return {
		folder,
		context,
		observer,
		milk: context.edits.row('notes', 'milk'),
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

/** Hold every `set` of `notes` until `release` is called. */
function holdSaves(folder: Awaited<ReturnType<typeof open>>) {
	const set = folder.tables.notes.set;
	const gate = Promise.withResolvers<void>();
	let held = 0;
	folder.tables.notes.set = async (...args) => {
		held++;
		await gate.promise;
		return set(...args);
	};
	return {
		get held() {
			return held;
		},
		release: () => {
			folder.tables.notes.set = set;
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

test('a reread while the save runs keeps the typing, and typing meanwhile saves after it', async () => {
	const { folder, context, milk, cached } = await setup();
	const saves = holdSaves(folder);
	milk.change(cached(), { fields: { title: 'Oat milk' } });
	const saving = milk.save();
	await until(() => saves.held === 1);
	expect(context.saveState).toBe('saving');

	// Another tab changes the row while this save is held.
	const other = await open();
	cleanup.push(() => other.close());
	const from = expectOk(await other.tables.notes.get('milk'))!;
	expectOk(
		await other.tables.notes.set('milk', from, { body: 'Three litres' }),
	);
	await until(() => cached().body === 'Three litres');
	expect(milk.shown(cached()).fields.title).toBe('Oat milk');

	milk.change(cached(), { fields: { title: 'Oat milk, cold' } });
	saves.release();
	await saving;
	expect(milk.shown(cached()).fields.title).toBe('Oat milk, cold');
	await until(() => !milk.held);

	const stored = expectOk(await folder.tables.notes.get('milk'))!;
	expect(stored.fields).toEqual({ title: 'Oat milk, cold', done: false });
	expect(stored.body).toBe('Three litres');
	expect(cached().fields.title).toBe('Oat milk, cold');
	expect(context.saveState).toBe('saved');
});

test('a failed save keeps the typing and its error, and save() after recovery saves it', async () => {
	const { context, milk, cached } = await setup();
	const restore = fillDisk();
	milk.change(cached(), { fields: { title: 'Oat milk' } });
	await milk.save();
	expect(milk.held).toBe(true);
	expect(milk.error?.name).toBe('StorageFailed');
	expect(milk.shown(cached()).fields.title).toBe('Oat milk');
	expect(context.saveState).toBe('failed');
	expect(context.edits.failures.map(({ id }) => id)).toEqual(['milk']);

	restore();
	await milk.save();
	expect(milk.held).toBe(false);
	expect(milk.error).toBeUndefined();
	expect(cached().fields.title).toBe('Oat milk');
	expect(context.saveState).toBe('saved');
});

test('a later malformed source cannot hide a failed draft', async () => {
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
	expect(context.edits.failures.map(({ id }) => id)).toEqual(['milk']);
	expect(milk.discard()).toMatchObject({ fields: { title: 'Oat milk' } });
	expect(milk.pending).toBeUndefined();
});

test('a failed reread never places a submitted row in the observed cache', async () => {
	const { folder, context, observer, milk, cached } = await setup();
	const other = await open();
	cleanup.push(() => other.close());
	const base = expectOk(await other.tables.notes.get('milk'))!;
	const list = folder.tables.notes.list;
	folder.tables.notes.list = async () => {
		throw new Error('Read failed');
	};
	expectOk(
		await other.tables.notes.set('milk', base, { fields: { done: true } }),
	);
	milk.change(cached(), { fields: { title: 'Oat milk' } });
	await milk.save();
	expect(observer.getCurrentResult().isError).toBe(true);
	expect(cached().fields.title).toBe('Milk');
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields).toEqual({
		title: 'Oat milk',
		done: true,
	});
	folder.tables.notes.list = list;
	await observer.refetch();
	expect(cached().fields).toEqual({ title: 'Oat milk', done: true });
	expect(context.saveState).toBe('saved');
});

test('a storage failure without a held row is reported as a past failure', async () => {
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

test('close sends typing that waits for its pause and refuses input after it', async () => {
	const { context, milk, cached } = await setup({ saveAfterMs: 60_000 });
	const row = cached();
	milk.change(row, { fields: { title: 'Oat milk' } });
	const closing = context.close();
	expect(milk.change(row, { fields: { title: 'Too late' } })).toBe(false);
	expect(await closing).toEqual([]);

	const reopened = await open();
	cleanup.push(() => reopened.close());
	expect(expectOk(await reopened.tables.notes.get('milk'))?.fields.title).toBe(
		'Oat milk',
	);
});

test('close waits for a started file action and an app-owned text draft', async () => {
	const { folder, context } = await setup();
	const actionStarted = Promise.withResolvers<void>();
	const releaseAction = Promise.withResolvers<void>();
	const action = context.run(async () => {
		actionStarted.resolve();
		await releaseAction.promise;
		return folder.files.write('action.txt', null, 'done');
	});
	await actionStarted.promise;
	let textSent = false;
	context.registerWork({
		get busy() {
			return !textSent;
		},
		get failed() {
			return false;
		},
		async settle() {
			const saved = await folder.files.write('draft.txt', null, 'typed');
			expect(saved.error).toBeNull();
			textSent = true;
		},
	});
	const closing = context.close();
	try {
		await until(() => textSent);
		// The action still owns the handle while the text draft has landed.
		expect(textSent).toBe(true);
	} finally {
		releaseAction.resolve();
	}
	expect((await action).error).toBeNull();
	await closing;
	const reopened = await open();
	cleanup.push(() => reopened.close());
	expect(
		await expectOk(await reopened.files.read('action.txt'))?.content.text(),
	).toBe('done');
	expect(
		await expectOk(await reopened.files.read('draft.txt'))?.content.text(),
	).toBe('typed');
});

test('close answers the typing whose save failed', async () => {
	const { context, milk, cached } = await setup({ saveAfterMs: 60_000 });
	fillDisk();
	milk.change(cached(), { body: 'Oat, two litres' });
	const unsaved = await context.close();
	expect(unsaved).toMatchObject([
		{ table: 'notes', id: 'milk', body: 'Oat, two litres' },
	]);
	expect(unsaved[0]?.error?.name).toBe('StorageFailed');
});

test('delete waits for the running save, then deletes the row and lets its typing go', async () => {
	const { folder, context, milk, cached } = await setup();
	const saves = holdSaves(folder);
	milk.change(cached(), { fields: { title: 'Oat milk' } });
	void milk.save();
	await until(() => saves.held === 1);
	const deleting = context.edits.delete('notes', 'milk');
	expect(milk.locked).toBe(true);
	expect(milk.change(cached(), { fields: { title: 'Later' } })).toBe(false);
	saves.release();

	expect(expectOk(await deleting)).toEqual({ deleted: true });
	expect(milk.held).toBe(false);
	expect(expectOk(await folder.tables.notes.get('milk'))).toBeUndefined();
	expect(context.saveState).toBe('saved');
});

test('delete refuses to discard typing after a failed save', async () => {
	const { folder, context, milk, cached } = await setup();
	const restore = fillDisk();
	milk.change(cached(), { fields: { title: 'Oat milk' } });
	await milk.save();

	const refused = await context.edits.delete('notes', 'milk');
	expect(refused.error?.name).toBe('NotStarted');
	expect(milk.held).toBe(true);
	expect(milk.shown(cached()).fields.title).toBe('Oat milk');
	expect(expectOk(await folder.tables.notes.get('milk'))?.fields.title).toBe(
		'Milk',
	);

	restore();
	expect(expectOk(await context.edits.delete('notes', 'milk'))).toEqual({
		deleted: true,
	});
	expect(milk.held).toBe(false);
});

test('delete saves held typing once, while a second save cannot restore the row', async () => {
	const { folder, context, milk, cached } = await setup({
		saveAfterMs: 60_000,
	});
	milk.change(cached(), { fields: { title: 'Oat milk' } });
	const saves = holdSaves(folder);
	const deleting = context.edits.delete('notes', 'milk');
	// As the detail does when the person leaves the field, or the view goes away.
	const saving = milk.save();
	await until(() => saves.held === 1);
	saves.release();
	expect(expectOk(await deleting)).toEqual({ deleted: true });
	await saving;
	await context.edits.settled();

	expect(saves.held).toBe(1);
	expect(milk.held).toBe(false);
	expect(expectOk(await folder.tables.notes.get('milk'))).toBeUndefined();
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
