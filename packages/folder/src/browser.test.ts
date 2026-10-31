/** The folder over the browser's IndexedDB repository. */
import 'fake-indexeddb/auto';
import { beforeEach, expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { Type } from 'typebox';
import { unwrap } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { closeDevice, openDevice, openFolder } from './browser.js';

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
	const folder = expectOk(await openFolder({ tables }));
	const notes = folder.tables.notes;
	expect(
		(await notes.create('a', { fields: { title: 'A' } })).error,
	).toBeNull();
	expect(folder.files().map((file) => file.path)).toEqual(['notes/a.md']);

	// Another tab over the same origin's folder.
	const other = expectOk(await openFolder({ tables }));
	const theirs = other.tables.notes;
	expect(theirs.row('a')?.fields).toEqual({ title: 'A' });

	expect(
		(await notes.update('a', { fields: { pinned: true } })).error,
	).toBeNull();
	await other.refresh();
	expect(
		(
			await theirs.update('a', {
				fields: { title: 'Renamed in the other tab' },
			})
		).error,
	).toBeNull();
	expect(theirs.row('a')?.fields).toEqual({
		title: 'Renamed in the other tab',
		pinned: true,
	});
	await folder.close();
	await other.close();
});

test('create refuses a file another tab already made', async () => {
	const folder = expectOk(await openFolder({ tables }));
	const other = expectOk(await openFolder({ tables }));
	expect(
		(await other.tables.notes.create('same', { fields: { title: 'Theirs' } }))
			.error,
	).toBeNull();
	await folder.refresh();
	const result = await folder.tables.notes.create('same', {
		fields: { title: 'Mine' },
	});
	expect(result.error?.name).toBe('Exists');
	await folder.close();
	await other.close();
});

test('the browser folder refuses inside the desktop app', async () => {
	// SAFETY: Tauri marks its pages with a global `isTauri` flag; the test sets and removes it.
	const scope = globalThis as { isTauri?: boolean };
	scope.isTauri = true;
	try {
		const opened = await openFolder({ tables });
		expect(opened.error?.name).toBe('InsideTauri');
	} finally {
		delete scope.isTauri;
	}
});

test('a disposed device stops its Worker, and every later call is Unavailable', async () => {
	const device = unwrap(
		await openDevice(
			defineContract({
				name: 'recorder',
				collections: { audio: { path: 'recordings/{id}.{ext}' } },
			}),
		),
	);
	// Starts the Worker; Bun has no private file system, so it answers either way.
	await device.audio.list();
	closeDevice(device);
	const after = await device.audio.list();
	expect(after.error).toMatchObject({
		name: 'Unavailable',
		cause: { name: 'WorkerFailed' },
	});
});
