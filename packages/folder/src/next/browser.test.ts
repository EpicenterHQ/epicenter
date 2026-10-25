/** The folder over the browser's IndexedDB repository. */
import 'fake-indexeddb/auto';
import { beforeEach, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';

const tables = {
	notes: Type.Object({
		title: Type.String(),
		pinned: Type.Optional(Type.Boolean()),
	}),
};

beforeEach(() => {
	globalThis.indexedDB = new IDBFactory();
});

test('create, update, a second tab, and close over IndexedDB', async () => {
	const folder = expectOk(await openFolder({ tables, throttleMs: 5 }));
	const notes = folder.tables.notes;
	expect(
		(await notes.create('a', { fields: { title: 'A' } })).error,
	).toBeNull();
	expect(folder.files().map((file) => file.path)).toEqual(['notes/a.md']);

	// Another tab over the same origin's folder.
	const other = expectOk(await openFolder({ tables, throttleMs: 5 }));
	const theirs = other.tables.notes;
	expect(theirs.row('a')?.fields).toEqual({ title: 'A' });

	const saved = notes.update('a', { fields: { pinned: true } });
	expect(
		(
			await theirs.update('a', {
				fields: { title: 'Renamed in the other tab' },
			})
		).error,
	).toBeNull();
	expect((await saved).error).toBeNull();

	// The other tab hears of the save and reads it.
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(theirs.row('a')?.fields).toEqual({
		title: 'Renamed in the other tab',
		pinned: true,
	});
	await folder.close();
	await other.close();
});

test('create refuses a file another tab already made', async () => {
	const folder = expectOk(await openFolder({ tables, throttleMs: 5 }));
	const other = expectOk(await openFolder({ tables, throttleMs: 5 }));
	expect(
		(await other.tables.notes.create('same', { fields: { title: 'Theirs' } }))
			.error,
	).toBeNull();
	const result = await folder.tables.notes.create('same', {
		fields: { title: 'Mine' },
	});
	expect(result.error?.name).toBe('Exists');
	await folder.close();
	await other.close();
});
