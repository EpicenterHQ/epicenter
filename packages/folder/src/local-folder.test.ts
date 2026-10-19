/**
 * The browser's default local folder, `openFolder({ tables })`.
 * Each test starts a fresh IndexedDB profile and reopens the same one to show
 * what a closed handle left behind.
 * Key behaviors:
 * - Work saved through files and tables is there after close and reopen
 * - A schema that does not fit never refuses a save or discards source
 * - Another handle of the origin hears a committed save; close ends listening
 * - A failed save returns its reason, leaves storage unchanged, and shows in status
 * - Close lets a started save finish, then releases listeners and the database
 */
import 'fake-indexeddb/auto';
import { beforeEach, expect, expectTypeOf, test } from 'bun:test';
import { IDBFactory as FakeIndexedDB } from 'fake-indexeddb';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import { openRepository } from './browser/repository.js';
import type { Folder, FolderChange, FolderStatus } from './contract.js';
import { openFolder as openAutomaticFolder } from './index.js';

const notes = Type.Object({
	title: Type.String(),
	done: Type.Optional(Type.Boolean()),
});

beforeEach(() => {
	globalThis.indexedDB = new FakeIndexedDB() as unknown as IDBFactory;
});

const open = async () => expectOk(await openFolder({ tables: { notes } }));

/** Make every IndexedDB write fail the way a full disk does. */
async function withFullDisk<T>(work: () => Promise<T>): Promise<T> {
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	try {
		return await work();
	} finally {
		IDBObjectStore.prototype.put = put;
	}
}

const idle: FolderStatus = {
	saving: false,
	storageFailure: null,
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function nextChange(folder: {
	onChange: (listener: (change: FolderChange) => void) => () => void;
}) {
	return new Promise<FolderChange>((resolve, reject) => {
		const timer = setTimeout(() => {
			stop();
			reject(new Error('No change was heard'));
		}, 2000);
		const stop = folder.onChange((change) => {
			clearTimeout(timer);
			stop();
			resolve(change);
		});
	});
}

test('a fresh profile opens empty without an app, account, remote, or network', async () => {
	const folder = await open();
	const publicFolder: Folder<{ notes: typeof notes }> = folder;
	void publicFolder;
	expect(expectOk(await folder.files.list())).toEqual([]);
	expect(expectOk(await folder.tables.notes.list())).toEqual([]);
	expect(expectOk(await folder.tables.notes.get('missing'))).toBeUndefined();
	expect(folder.status).toEqual(idle);
	await folder.close();
});

test('old OPFS access cannot block the current IndexedDB folder', async () => {
	const storage = Object.getOwnPropertyDescriptor(navigator, 'storage');
	let opened = 0;
	Object.defineProperty(navigator, 'storage', {
		configurable: true,
		value: {
			async getDirectory() {
				opened++;
				throw new DOMException('Denied', 'SecurityError');
			},
		},
	});
	try {
		const first = await open();
		expectOk(await first.files.write('readme.md', null, 'saved'));
		await first.close();
		const second = await open();
		expect(await expectOk(await second.files.read('readme.md'))?.content.text()).toBe('saved');
		await second.close();
		expect(opened).toBe(0);
	} finally {
		if (storage === undefined) Reflect.deleteProperty(navigator, 'storage');
		else Object.defineProperty(navigator, 'storage', storage);
	}
});

test('files and rows saved before close are there after reopening', async () => {
	const first = await open();
	expectOk(await first.files.write('readme.md', null, 'hello'));
	const { sent } = expectOk(
		await first.tables.notes.set('a', null, {
			fields: { title: 'Milk' },
			body: 'Body',
		}),
	);
	expect(sent.fields).toEqual({ title: 'Milk' });
	expectOk(await first.files.write('notes/a/photo.txt', null, 'x'));
	await first.close();

	const second = await open();
	const readme = expectOk(await second.files.read('readme.md'));
	expect(await readme?.content.text()).toBe('hello');
	const row = expectOk(await second.tables.notes.get('a'));
	expect(row).toMatchObject({
		id: 'a',
		body: 'Body',
		fields: { title: 'Milk' },
		issues: null,
	});
	if (row !== undefined && row.issues === null)
		expectTypeOf(row.fields.title).toEqualTypeOf<string>();
	expect(expectOk(await second.files.list())).toEqual([
		'notes/a.md',
		'notes/a/photo.txt',
		'readme.md',
	]);
	expect(expectOk(await second.files.list('notes/a/'))).toEqual([
		'notes/a/photo.txt',
	]);
	const deleted = expectOk(await second.tables.notes.delete('a', row ?? null));
	expect(deleted).toEqual({ deleted: true });
	expect(expectOk(await second.files.list())).toEqual(['notes/a/photo.txt', 'readme.md']);
	await second.close();
});

test('binary files persist exact bytes and a competing binary save keeps its whole change', async () => {
	const first = await open();
	const base = new Uint8Array([0, 1, 255]);
	const saving = first.files.write('audio/clip.bin', null, base);
	base[1] = 9;
	expectOk(await saving);
	const second = await open();
	const observed = expectOk(await second.files.read('audio/clip.bin'))!;
	expect(new Uint8Array(await observed.content.arrayBuffer())).toEqual(
		new Uint8Array([0, 1, 255]),
	);
	expectOk(
		await first.files.write(
			'audio/clip.bin',
			new Uint8Array([0, 1, 255]),
			new Uint8Array([0, 2, 255]),
		),
	);
	expectOk(
		await second.files.write(
			'audio/clip.bin',
			new Uint8Array([0, 1, 255]),
			new Uint8Array([0, 3, 255]),
		),
	);
	await first.close();
	await second.close();
	const reopened = await open();
	const stored = expectOk(await reopened.files.read('audio/clip.bin'))!;
	expect(new Uint8Array(await stored.content.arrayBuffer())).toEqual(
		new Uint8Array([0, 3, 255]),
	);
	await reopened.close();
});

test('a schema that does not fit never refuses a save or discards unknown fields', async () => {
	const first = await open();
	expectOk(
		await first.files.write(
			'notes/a.md',
			null,
			'---\n"10": ten\ntitle: 42\nextra: kept\n---\nBody',
		),
	);
	const row = expectOk(await first.tables.notes.get('a'))!;
	expect(row.fields).toEqual({ '10': 'ten', title: 42, extra: 'kept' });
	expect(row.issues?.map((issue) => issue.kind)).toEqual(['schema']);
	const { sent } = expectOk(
		await first.tables.notes.set('a', row, { fields: { done: 'maybe' } }),
	);
	expect(sent.fields).toEqual({
		'10': 'ten',
		title: 42,
		extra: 'kept',
		done: 'maybe',
	});
	await first.close();

	const second = await open();
	const again = expectOk(await second.tables.notes.get('a'))!;
	expect(again.text).toBe(sent.text);
	expect(again.fields).toEqual(sent.fields);
	expect(again.issues?.length).toBeGreaterThan(0);
	await second.close();
});

test('source with malformed frontmatter stays exact, readable as a file, and repairable', async () => {
	const broken = '---\ntitle: [broken\n---\nBody';
	const first = await open();
	expectOk(await first.files.write('notes/b.md', null, broken));
	const row = expectOk(await first.tables.notes.get('b'))!;
	expect(row.text).toBe(broken);
	expect(row.issues?.[0]?.kind).toBe('frontmatter');
	// Fields cannot be edited through broken frontmatter; the body can.
	const refused = await first.tables.notes.set('b', row, {
		fields: { title: 'x' },
	});
	expect(expectErr(refused).name).toBe('Unparseable');
	expectOk(await first.tables.notes.set('b', row, { body: 'New body' }));
	await first.close();

	const second = await open();
	const file = expectOk(await second.files.read('notes/b.md'));
	expect(await file?.content.text()).toBe('---\ntitle: [broken\n---\nNew body');
	const repaired = '---\ntitle: Fixed\n---\nNew body';
	expectOk(
		await second.files.write(
			'notes/b.md',
			'---\ntitle: [broken\n---\nNew body',
			repaired,
		),
	);
	const fixed = expectOk(await second.tables.notes.get('b'))!;
	expect(fixed.issues).toBeNull();
	expect(fixed.fields).toEqual({ title: 'Fixed' });
	await second.close();
});

test('another handle of the origin hears a committed save, and the saver hears its own', async () => {
	const a = await open();
	const b = await open();
	const heardByA = nextChange(a);
	const heardByB = nextChange(b);
	expectOk(await a.tables.notes.set('c', null, { fields: { title: 'One' } }));
	expect(await heardByA).toEqual({
		origin: 'this-handle',
		paths: ['notes/c.md'],
	});
	expect(await heardByB).toEqual({
		origin: 'other-handle',
		paths: ['notes/c.md'],
	});
	expect(expectOk(await b.tables.notes.get('c'))?.fields).toEqual({
		title: 'One',
	});
	await a.close();
	await b.close();
});

test('stopping a listener and closing the handle end its notifications', async () => {
	const a = await open();
	const b = await open();
	let stopped = 0;
	let released = 0;
	const stop = b.onChange(() => stopped++);
	b.onChange(() => released++);
	stop();
	expectOk(await a.files.write('one.md', null, 'x'));
	await settle();
	expect(stopped).toBe(0);
	expect(released).toBe(1);
	await b.close();
	expectOk(await a.files.write('two.md', null, 'y'));
	await settle();
	expect(released).toBe(1);
	await a.close();
});

test('a failed save returns the reason, leaves storage unchanged, and shows in status', async () => {
	const folder = await open();
	expectOk(await folder.files.write('keep.md', null, 'first'));
	const seen: FolderStatus[] = [];
	folder.onStatusChange((status) => seen.push(status));
	const changes: FolderChange[] = [];
	folder.onChange((change) => changes.push(change));

	const failure = await withFullDisk(async () =>
		expectErr(await folder.files.write('keep.md', 'first', 'second')),
	);
	expect(failure.name).toBe('StorageFailed');
	if (failure.name !== 'StorageFailed')
		throw new Error('Expected a storage failure');
	expect(failure.message).toContain('QuotaExceededError');
	expect(folder.status).toMatchObject({
		saving: false,
		storageFailure: failure,
	});
	await settle();
	expect(changes).toEqual([]);
	const kept = expectOk(await folder.files.read('keep.md'));
	expect(await kept?.content.text()).toBe('first');
	expect(expectOk(await folder.files.list())).toEqual(['keep.md']);

	// A successful no-op retry confirms the desired content is already stored.
	expectOk(await folder.files.write('keep.md', 'first', 'first'));
	expect(
		expectErr(await folder.files.write('keep.md/child', null, 'x')).name,
	).toBe('Occupied');
	expect(folder.status.storageFailure).toBeNull();
	expectOk(await folder.files.write('keep.md', 'first', 'third'));
	expect(folder.status).toEqual(idle);
	expect(
		seen.map((status) => [status.saving, status.storageFailure?.name ?? null]),
	).toEqual([
		[true, null],
		[false, 'StorageFailed'],
		[true, 'StorageFailed'],
		[false, null],
		[true, null],
		[false, null],
		[true, null],
		[false, null],
	]);
	await folder.close();

	const reopened = await open();
	const text = expectOk(await reopened.files.read('keep.md'));
	expect(await text?.content.text()).toBe('third');
	await reopened.close();
});

test('status is saving while a save is in progress and saved only after it commits', async () => {
	const folder = await open();
	const pending = folder.files.write('one.md', null, 'x');
	expect(folder.status.saving).toBe(true);
	expectOk(await pending);
	expect(folder.status).toEqual(idle);
	await folder.close();
});

test('close lets a started save finish, then rejects new work and releases listeners', async () => {
	const folder = await open();
	const other = await open();
	let status = 0;
	let changes = 0;
	folder.onStatusChange(() => status++);
	folder.onChange(() => changes++);

	const started = folder.files.write('late.md', null, 'kept');
	const closing = folder.close();
	expect(closing).toBe(folder.close());
	expect(() => folder.files.list()).toThrow('closed');
	expect(() => folder.tables.notes.get('a')).toThrow('closed');
	expect(() => folder.onChange(() => {})).toThrow('closed');
	expect(() => folder.onStatusChange(() => {})).toThrow('closed');
	expectOk(await started);
	await closing;

	const statusAfterClose = status;
	expectOk(await other.files.write('after.md', null, 'x'));
	await settle();
	expect(status).toBe(statusAfterClose);
	expect(changes).toBe(1);
	await other.close();

	const reopened = await open();
	expect(expectOk(await reopened.files.list())).toEqual([
		'after.md',
		'late.md',
	]);
	await reopened.close();
});

test('closing from a saving observer waits for the save it observed', async () => {
	const folder = await open();
	let closing: Promise<void> | undefined;
	folder.onStatusChange((status) => {
		if (status.saving) closing = folder.close();
	});
	expectOk(await folder.files.write('observed.md', null, 'kept'));
	await closing;
	const reopened = await open();
	const file = expectOk(await reopened.files.read('observed.md'));
	expect(await file?.content.text()).toBe('kept');
	await reopened.close();
});

test('a table that cannot be one directory, or missing IndexedDB, refuses to open', async () => {
	for (const table of ['', 'a/b', '..', '.git', 'con', 'HEAD', 'a: b'])
		expect(
			expectErr(await openFolder({ tables: { [table]: notes } })).name,
		).toBe('InvalidTable');
	const original = globalThis.indexedDB;
	Object.defineProperty(globalThis, 'indexedDB', {
		value: undefined,
		configurable: true,
		writable: true,
	});
	try {
		expect(expectErr(await openFolder({ tables: { notes } })).name).toBe(
			'Unavailable',
		);
	} finally {
		globalThis.indexedDB = original;
	}
});

test('browser writes refuse the same nonportable paths and row IDs as a directory', async () => {
	const folder = await open();
	for (const path of ['con.md', 'notes/a: b.md', 'a\\b', 'trailing.', 'HEAD/x'])
		expect(expectErr(await folder.files.write(path, null, 'x')).name).toBe('InvalidPath');
	for (const id of ['', 'con', 'a/b', 'a: b'])
		expect(expectErr(await folder.tables.notes.set(id, null, { body: 'x' })).name).toBe('InvalidId');
	expect(expectOk(await folder.files.list())).toEqual([]);
	await folder.close();
});

test('earlier nonportable browser paths remain readable for repair', async () => {
	const earlier = await openRepository('default');
	const snapshot = await earlier.storage.capture([]);
	expect(await earlier.storage.publish({
		revision: snapshot.state.revision,
		edits: new Map([
			['notes/a: b.md', '---\ntitle: Kept\n---\nSource\n'],
			['notes/.md', '---\ntitle: Empty stem\n---\nKept\n'],
		]),
	})).toBe(true);
	const folder = await open();
	expect(expectOk(await folder.files.list())).toEqual(['notes/.md', 'notes/a: b.md']);
	expect(await expectOk(await folder.files.read('notes/a: b.md'))?.content.text()).toContain('Source');
	expect(expectOk(await folder.tables.notes.list()).map((row) => row.id)).toEqual(['', 'a: b']);
	expect(expectOk(await folder.tables.notes.get(''))?.fields).toEqual({ title: 'Empty stem' });
	const raw = expectOk(await folder.tables.notes.get('a: b'))!;
	expect(raw.fields).toEqual({ title: 'Kept' });
	expect(expectErr(await folder.tables.notes.set('a: b', null, { body: 'changed' })).name).toBe('InvalidId');
	const { sent } = expectOk(await folder.tables.notes.set('a: b', raw, { body: 'Repaired\n' }));
	expect(await expectOk(await folder.files.read('notes/a: b.md'))?.content.text()).toContain('Repaired');
	expect(expectOk(await folder.tables.notes.delete('a: b', sent))).toEqual({ deleted: true });
	expect(expectOk(await folder.tables.notes.get('a: b'))).toBeUndefined();
	expect(expectErr(await folder.tables.notes.set('a: b', raw, { body: 'again' })).name).toBe('InvalidPath');
	await folder.close();
	earlier.close();
});

test('an existing HEAD stays readable but cannot be changed into Git state', async () => {
	const earlier = await openRepository('default');
	const snapshot = await earlier.storage.capture([]);
	expect(await earlier.storage.publish({
		revision: snapshot.state.revision,
		edits: new Map([['HEAD', 'notes\n']]),
	})).toBe(true);
	const folder = await open();
	expect(await expectOk(await folder.files.read('HEAD'))?.content.text()).toBe('notes\n');
	expect(expectErr(await folder.files.write('HEAD', 'notes\n', 'ref: refs/heads/main\n')).name).toBe('InvalidPath');
	expect(expectErr(await folder.files.delete('HEAD', 'notes\n')).name).toBe('InvalidPath');
	expect(await expectOk(await folder.files.read('HEAD'))?.content.text()).toBe('notes\n');
	await folder.close();
	earlier.close();
});

test('the automatic opener opens the browser default and refuses a directory in a browser', async () => {
	const folder = expectOk(await openAutomaticFolder({ tables: { notes } }));
	expectOk(
		await folder.tables.notes.set('d', null, { fields: { title: 'Auto' } }),
	);
	await folder.close();
	const browser = await open();
	expect(expectOk(await browser.tables.notes.get('d'))?.fields).toEqual({
		title: 'Auto',
	});
	await browser.close();

	expect(
		expectErr(
			await openAutomaticFolder({ directory: '/tmp/notes', tables: { notes } }),
		).name,
	).toBe('NotTauri');
	expect(
		expectErr(
			await openFolder({ directory: '/tmp/notes', tables: { notes } } as unknown as Parameters<typeof openFolder>[0]),
		).name,
	).toBe('NotTauri');
});
