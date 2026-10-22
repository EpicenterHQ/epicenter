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
import { changeSnapshot } from './browser/git/snapshot.js';
import { openRepository } from './browser/repository.js';
import { snapshotObject } from './browser/storage.js';
import { openFolder } from './browser.js';
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
	savingPaths: [],
	storageFailure: null,
	unsaved: [],
	failures: [],
	closing: false,
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
	expect(folder.getStatus()).toEqual(idle);
	folder.close();
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
		expectOk(await first.files.write('readme.md', 'saved'));
		first.close();
		const second = await open();
		expect(
			await expectOk(await second.files.read('readme.md'))?.content.text(),
		).toBe('saved');
		second.close();
		expect(opened).toBe(0);
	} finally {
		if (storage === undefined) Reflect.deleteProperty(navigator, 'storage');
		else Object.defineProperty(navigator, 'storage', storage);
	}
});

test('files and rows saved before close are there after reopening', async () => {
	const first = await open();
	expectOk(await first.files.write('readme.md', 'hello'));
	const stored = expectOk(
		await first.tables.notes.set('a', {
			fields: { title: 'Milk' },
			body: 'Body',
		}),
	);
	expect(stored.fields).toEqual({ title: 'Milk' });
	expectOk(await first.files.write('notes/a/photo.txt', 'x'));
	first.close();

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
	expectOk(await second.tables.notes.delete('a'));
	// A row that is already gone is deleted too.
	expectOk(await second.tables.notes.delete('a'));
	expect(expectOk(await second.files.list())).toEqual([
		'notes/a/photo.txt',
		'readme.md',
	]);
	second.close();
});

test('binary files persist exact bytes and a competing binary save keeps its whole change', async () => {
	const first = await open();
	const base = new Uint8Array([0, 1, 255]);
	const saving = first.files.write('audio/clip.bin', base);
	base[1] = 9;
	expectOk(await saving);
	const second = await open();
	const observed = expectOk(await second.files.read('audio/clip.bin'))!;
	expect(new Uint8Array(await observed.content.arrayBuffer())).toEqual(
		new Uint8Array([0, 1, 255]),
	);
	expectOk(
		await first.files.write('audio/clip.bin', new Uint8Array([0, 2, 255])),
	);
	expectOk(
		await second.files.write('audio/clip.bin', new Uint8Array([0, 3, 255])),
	);
	first.close();
	second.close();
	const reopened = await open();
	const stored = expectOk(await reopened.files.read('audio/clip.bin'))!;
	expect(new Uint8Array(await stored.content.arrayBuffer())).toEqual(
		new Uint8Array([0, 3, 255]),
	);
	reopened.close();
});

test('a schema that does not fit never refuses a save or discards unknown fields', async () => {
	const first = await open();
	expectOk(
		await first.files.write(
			'notes/a.md',
			'---\n"10": ten\ntitle: 42\nextra: kept\n---\nBody',
		),
	);
	const row = expectOk(await first.tables.notes.get('a'))!;
	expect(row.fields).toEqual({ '10': 'ten', title: 42, extra: 'kept' });
	expect(row.issues?.map((issue) => issue.kind)).toEqual(['schema']);
	const sent = expectOk(
		await first.tables.notes.set('a', { fields: { done: 'maybe' } }),
	);
	expect(sent.fields).toEqual({
		'10': 'ten',
		title: 42,
		extra: 'kept',
		done: 'maybe',
	});
	first.close();

	const second = await open();
	const again = expectOk(await second.tables.notes.get('a'))!;
	expect(again.text).toBe(sent.text);
	expect(again.fields).toEqual(sent.fields);
	expect(again.issues?.length).toBeGreaterThan(0);
	second.close();
});

test('source with malformed frontmatter stays exact, readable as a file, and repairable', async () => {
	const broken = '---\ntitle: [broken\n---\nBody';
	const first = await open();
	expectOk(await first.files.write('notes/b.md', broken));
	const row = expectOk(await first.tables.notes.get('b'))!;
	expect(row.text).toBe(broken);
	expect(row.issues?.[0]?.kind).toBe('frontmatter');
	// Fields cannot be edited through broken frontmatter; the body can.
	const refused = await first.tables.notes.set('b', {
		fields: { title: 'x' },
	});
	expect(expectErr(refused).name).toBe('Unparseable');
	expectOk(await first.tables.notes.set('b', { body: 'New body' }));
	first.close();

	const second = await open();
	const file = expectOk(await second.files.read('notes/b.md'));
	expect(await file?.content.text()).toBe('---\ntitle: [broken\n---\nNew body');
	const repaired = '---\ntitle: Fixed\n---\nNew body';
	expectOk(await second.files.write('notes/b.md', repaired));
	const fixed = expectOk(await second.tables.notes.get('b'))!;
	expect(fixed.issues).toBeNull();
	expect(fixed.fields).toEqual({ title: 'Fixed' });
	second.close();
});

test('a row set applies its fields to what another writer stored', async () => {
	const first = await open();
	const second = await open();
	try {
		const original = '---\ntitle: before\n---\nbody\n';
		expectOk(await first.files.write('notes/a.md', original));
		expectOk(
			await second.files.write(
				'notes/a.md',
				'---\ntitle: outside\n---\nbody\n',
			),
		);
		expectOk(
			await first.tables.notes.set('a', { fields: { title: 'before' } }),
		);
		expect(expectOk(await first.tables.notes.get('a'))?.fields?.title).toBe(
			'before',
		);
	} finally {
		first.close();
		second.close();
	}
});

test('another handle of the origin hears a committed save, and the saver hears its own', async () => {
	const a = await open();
	const b = await open();
	const heardByA = nextChange(a);
	const heardByB = nextChange(b);
	expectOk(await a.tables.notes.set('c', { fields: { title: 'One' } }));
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
	a.close();
	b.close();
});

test('stopping a listener and closing the handle end its notifications', async () => {
	const a = await open();
	const b = await open();
	let stopped = 0;
	let released = 0;
	const stop = b.onChange(() => stopped++);
	b.onChange(() => released++);
	stop();
	expectOk(await a.files.write('one.md', 'x'));
	await settle();
	expect(stopped).toBe(0);
	expect(released).toBe(1);
	b.close();
	expectOk(await a.files.write('two.md', 'y'));
	await settle();
	expect(released).toBe(1);
	a.close();
});

test('a failed save returns the reason, leaves storage unchanged, and shows in status', async () => {
	const folder = await open();
	expectOk(await folder.files.write('keep.md', 'first'));
	const seen: FolderStatus[] = [];
	folder.onStatusChange((status) => seen.push(status));
	const changes: FolderChange[] = [];
	folder.onChange((change) => changes.push(change));

	const failure = await withFullDisk(async () =>
		expectErr(await folder.files.write('keep.md', 'second')),
	);
	expect(failure.name).toBe('StorageFailed');
	if (failure.name !== 'StorageFailed')
		throw new Error('Expected a storage failure');
	expect(failure.message).toContain('QuotaExceededError');
	expect(folder.getStatus()).toMatchObject({
		saving: false,
		storageFailure: failure,
	});
	await settle();
	expect(changes).toEqual([]);
	const kept = expectOk(await folder.files.read('keep.md'));
	expect(await kept?.content.text()).toBe('first');
	expect(expectOk(await folder.files.list())).toEqual(['keep.md']);

	// A successful no-op retry confirms the desired content is already stored.
	expectOk(await folder.files.write('keep.md', 'first'));
	expect(expectErr(await folder.files.write('keep.md/child', 'x')).name).toBe(
		'Occupied',
	);
	expect(folder.getStatus().storageFailure).toBeNull();
	expectOk(await folder.files.write('keep.md', 'third'));
	expect(folder.getStatus()).toEqual(idle);
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
	folder.close();

	const reopened = await open();
	const text = expectOk(await reopened.files.read('keep.md'));
	expect(await text?.content.text()).toBe('third');
	reopened.close();
});

test('status is saving while a save is in progress and saved only after it commits', async () => {
	const folder = await open();
	const pending = folder.files.write('one.md', 'x');
	expect(folder.getStatus().saving).toBe(true);
	expectOk(await pending);
	expect(folder.getStatus()).toEqual(idle);
	folder.close();
});

test('close releases listeners immediately and preserves a started save outcome', async () => {
	const folder = await open();
	const other = await open();
	let status = 0;
	let changes = 0;
	folder.onStatusChange(() => status++);
	folder.onChange(() => changes++);

	const started = folder.files.write('late.md', 'kept');
	const closing = folder.close();
	expect(closing).toBeUndefined();
	expect(folder.close()).toBeUndefined();
	expect(() => folder.onChange(() => {})).toThrow('closed');
	expect(() => folder.onStatusChange(() => {})).toThrow('closed');
	expect(expectErr(await started).name).toBe('StorageFailed');
	// New storage calls refuse from the moment close starts.
	expect(() => folder.files.list()).toThrow('closed');
	await expect(folder.tables.notes.get('a')).rejects.toThrow('closed');

	const statusAfterClose = status;
	expectOk(await other.files.write('after.md', 'x'));
	await settle();
	expect(status).toBe(statusAfterClose);
	expect(changes).toBe(0);
	other.close();

	const reopened = await open();
	expect(expectOk(await reopened.files.list())).toEqual(['after.md']);
	reopened.close();
});

test('closing from a saving observer releases the handle immediately', async () => {
	const folder = await open();
	let closed = false;
	folder.onStatusChange((status) => {
		if (status.saving) {
			folder.close();
			closed = true;
		}
	});
	expect(expectErr(await folder.files.write('observed.md', 'kept')).name).toBe('StorageFailed');
	expect(closed).toBe(true);
	const reopened = await open();
	const file = expectOk(await reopened.files.read('observed.md'));
	expect(file).toBeUndefined();
	reopened.close();
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
		expect(expectErr(await folder.files.write(path, 'x')).name).toBe(
			'InvalidPath',
		);
	for (const id of ['', 'con', 'a/b', 'a: b'])
		expect(
			expectErr(await folder.tables.notes.set(id, { body: 'x' })).name,
		).toBe('InvalidId');
	expect(expectOk(await folder.files.list())).toEqual([]);
	folder.close();
});

test('earlier nonportable browser paths remain readable for repair', async () => {
	const earlier = await openRepository('default');
	const snapshot = await earlier.storage.capture([]);
	const candidate = await changeSnapshot({
		root: snapshot.state.workingTree,
		edits: new Map([
			['notes/a: b.md', '---\ntitle: Kept\n---\nSource\n'],
			['notes/.md', '---\ntitle: Empty stem\n---\nKept\n'],
		]),
		read: async (oid) => snapshotObject(snapshot, oid),
	});
	expect(
		await earlier.storage.publish({
			expected: snapshot.state,
			workingTree: candidate.tree,
			objects: candidate.objects,
		}),
	).toBe(true);
	const folder = await open();
	expect(expectOk(await folder.files.list())).toEqual([
		'notes/.md',
		'notes/a: b.md',
	]);
	expect(
		await expectOk(await folder.files.read('notes/a: b.md'))?.content.text(),
	).toContain('Source');
	expect(
		expectOk(await folder.tables.notes.list()).map((row) => row.id),
	).toEqual(['', 'a: b']);
	expect(expectOk(await folder.tables.notes.get(''))?.fields).toEqual({
		title: 'Empty stem',
	});
	const raw = expectOk(await folder.tables.notes.get('a: b'))!;
	expect(raw.fields).toEqual({ title: 'Kept' });
	// An existing nonportable row can be repaired and removed, never made.
	expectOk(await folder.tables.notes.set('a: b', { body: 'Repaired\n' }));
	expect(
		await expectOk(await folder.files.read('notes/a: b.md'))?.content.text(),
	).toContain('Repaired');
	expectOk(await folder.tables.notes.delete('a: b'));
	expect(expectOk(await folder.tables.notes.get('a: b'))).toBeUndefined();
	expect(
		expectErr(await folder.tables.notes.set('a: b', { body: 'again' })).name,
	).toBe('InvalidId');
	expect(
		expectErr(await folder.files.write('notes/a: b.md', 'again')).name,
	).toBe('InvalidPath');
	folder.close();
	earlier.close();
});

test('an existing HEAD stays readable but cannot be changed into Git state', async () => {
	const earlier = await openRepository('default');
	const snapshot = await earlier.storage.capture([]);
	const candidate = await changeSnapshot({
		root: snapshot.state.workingTree,
		edits: new Map([['HEAD', 'notes\n']]),
		read: async (oid) => snapshotObject(snapshot, oid),
	});
	expect(
		await earlier.storage.publish({
			expected: snapshot.state,
			workingTree: candidate.tree,
			objects: candidate.objects,
		}),
	).toBe(true);
	const folder = await open();
	expect(await expectOk(await folder.files.read('HEAD'))?.content.text()).toBe(
		'notes\n',
	);
	expect(
		expectErr(await folder.files.write('HEAD', 'ref: refs/heads/main\n')).name,
	).toBe('InvalidPath');
	expect(expectErr(await folder.files.delete('HEAD')).name).toBe('InvalidPath');
	expect(await expectOk(await folder.files.read('HEAD'))?.content.text()).toBe(
		'notes\n',
	);
	folder.close();
	earlier.close();
});

test('the automatic opener opens the browser default and refuses a directory in a browser', async () => {
	const folder = expectOk(await openAutomaticFolder({ tables: { notes } }));
	expectOk(await folder.tables.notes.set('d', { fields: { title: 'Auto' } }));
	folder.close();
	const browser = await open();
	expect(expectOk(await browser.tables.notes.get('d'))?.fields).toEqual({
		title: 'Auto',
	});
	browser.close();

	expect(
		expectErr(
			await openAutomaticFolder({
				directory: '/tmp/notes',
				tables: { notes },
			} as unknown as Parameters<typeof openAutomaticFolder>[0]),
		).name,
	).toBe('NotTauri');
	expect(
		expectErr(
			await openFolder({
				directory: '/tmp/notes',
				tables: { notes },
			} as unknown as Parameters<typeof openFolder>[0]),
		).name,
	).toBe('NotTauri');
});
