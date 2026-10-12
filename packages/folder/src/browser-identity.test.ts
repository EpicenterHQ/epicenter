/**
 * Which OPFS directory is a browser folder, decided by the production opener
 * under the folder's open Web Lock, over the in-memory stand-in.
 *
 * Key behaviors:
 * - A missing or empty directory becomes the folder, and its ready marker
 *   names the captured address; reopening opens it as it is
 * - A marker that names the address opens, whatever other properties it
 *   records, and is never rewritten
 * - A marker for another address, a marker that names none, a directory
 *   holding anything without a marker, and a path that is not a directory
 *   are refused, and nothing in them is written
 * - A first open whose marker write fails, or whose close is unconfirmed, is
 *   refused; the next open starts again only where nothing was published
 * - The default opener needs OPFS, writable streams, and Web Locks, and
 *   never touches IndexedDB
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFolder, openFolder } from './browser.js';
import {
	type MemoryOpfs,
	memoryOpfs,
	opfsEnvironment,
} from './opfs.test-support.js';
import { ensureDirectory } from './opfs-store.js';
import { createWebLocks, useWebLocks } from './web-locks.test-support.js';

useWebLocks();

const definition = defineFolder({ kv: {}, tables: {} });
const id = 'so.epicenter.identitytest';
const ROOT = `Epicenter/local/${id}`;
const MARKER = `${ROOT}/.git/epicenter-folder.json`;
const ADDRESS = JSON.stringify(['release', 'local', null, id]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Every file and directory below the origin root. */
const everything = (opfs: MemoryOpfs) => ({
	files: opfs.files(),
	directories: opfs.directories(),
});

const markerOf = (opfs: MemoryOpfs) =>
	JSON.parse(decoder.decode(opfs.files().get(MARKER)));

async function open(opfs: MemoryOpfs) {
	return openFolder({
		id,
		definition,
		browser: { opfs: opfsEnvironment(opfs) },
	});
}

/** Open, expecting a refusal that left everything below the origin root as it was. */
async function refusedUnchanged(opfs: MemoryOpfs) {
	const before = everything(opfs);
	const refused = expectErr(await open(opfs));
	expect(refused.name).toBe('Unavailable');
	expect(everything(opfs)).toEqual(before);
	return refused.message;
}

describe('a ready marker names the folder', () => {
	test('a fresh origin becomes the folder; its marker names the address and reopening keeps it', async () => {
		const opfs = memoryOpfs();
		const first = expectOk(await open(opfs));
		expect(first.location).toEqual({ kind: 'opfs', directory: ROOT });
		expect(markerOf(opfs)).toEqual({ address: ADDRESS });
		const marker = opfs.files().get(MARKER);
		expectOk(await first.files.create('notes/a.md', '# A\n'));
		expect((await first.git.commit()).status).toBe('committed');
		await first.close();

		const again = expectOk(await open(opfs));
		expect(
			decoder.decode(expectOk(await again.files.read('notes/a.md')).bytes),
		).toBe('# A\n');
		expect(expectOk(await again.git.log(10))).toHaveLength(1);
		expect(opfs.files().get(MARKER)).toEqual(marker!);
		await again.close();
	});

	test('a marker with extra properties opens without rewriting the record', async () => {
		for (const metadata of [{ label: 'fixture' }, null]) {
			const opfs = memoryOpfs();
			const bytes = encoder.encode(
				JSON.stringify({ address: ADDRESS, metadata }),
			);
			opfs.put(MARKER, bytes);
			opfs.put(`${ROOT}/kept.md`, encoder.encode('kept'));
			const folder = expectOk(await open(opfs));
			expect(
				decoder.decode(expectOk(await folder.files.read('kept.md')).bytes),
			).toBe('kept');
			await folder.close();
			expect(opfs.files().get(MARKER)).toEqual(bytes);
		}
	});

	test('a marker for another address is refused, and nothing is written', async () => {
		for (const other of [
			['development', 'local', null, id],
			['release', 'local', null, 'so.epicenter.other'],
			['release', 'accounts', 'a'.repeat(64), id],
		]) {
			const opfs = memoryOpfs();
			opfs.put(
				MARKER,
				encoder.encode(JSON.stringify({ address: JSON.stringify(other) })),
			);
			opfs.put(`${ROOT}/theirs.md`, encoder.encode('theirs'));
			expect(await refusedUnchanged(opfs)).toContain(
				`marked for ${JSON.stringify(other)}`,
			);
		}
	});

	test('a marker that names no address is refused and left as it is, even with nothing beside it', async () => {
		for (const bytes of [
			encoder.encode('not json'),
			encoder.encode('null'),
			encoder.encode('[]'),
			encoder.encode('{}'),
			encoder.encode('{"address":7}'),
			Uint8Array.of(
				0xff,
				...encoder.encode(JSON.stringify({ address: ADDRESS })),
			),
		]) {
			const opfs = memoryOpfs();
			opfs.put(MARKER, bytes);
			expect(await refusedUnchanged(opfs)).toContain(
				'has a ready marker that names no address',
			);
		}
	});

	test('a directory holding anything without a marker is refused and left as it is', async () => {
		const cases: [string, (opfs: MemoryOpfs) => Promise<void>][] = [
			[
				'found.txt',
				async (opfs) => opfs.put(`${ROOT}/found.txt`, encoder.encode('found')),
			],
			[
				'drafts',
				async (opfs) => {
					expectOk(
						await ensureDirectory(await opfs.getDirectory(), `${ROOT}/drafts`),
					);
				},
			],
			[
				'.git/HEAD',
				async (opfs) =>
					opfs.put(
						`${ROOT}/.git/HEAD`,
						encoder.encode('ref: refs/heads/main\n'),
					),
			],
			[
				'found.txt',
				async (opfs) => {
					// An empty marker is no marker, so it vouches for nothing beside it.
					opfs.put(MARKER, new Uint8Array());
					opfs.put(`${ROOT}/found.txt`, encoder.encode('found'));
				},
			],
			[
				'.git',
				async (opfs) => opfs.put(`${ROOT}/.git`, encoder.encode('a file')),
			],
			[
				'.git/epicenter-folder.json',
				async (opfs) =>
					opfs.put(`${MARKER}/inner`, encoder.encode('a directory')),
			],
		];
		for (const [occupant, arrange] of cases) {
			const opfs = memoryOpfs();
			await arrange(opfs);
			expect(await refusedUnchanged(opfs)).toContain(
				`holds '${occupant}' but no ready marker for ${ADDRESS}`,
			);
		}
	});

	test('a folder path that is not a directory is refused', async () => {
		for (const blocked of [ROOT, 'Epicenter/local']) {
			const opfs = memoryOpfs();
			opfs.put(blocked, encoder.encode('a file'));
			expect(await refusedUnchanged(opfs)).toContain('is not a directory');
		}
	});

	test('an empty directory, or one a first open left with only an empty marker, becomes the folder', async () => {
		for (const arrange of [
			async (opfs: MemoryOpfs) => {
				expectOk(
					await ensureDirectory(await opfs.getDirectory(), `${ROOT}/.git`),
				);
			},
			async (opfs: MemoryOpfs) => opfs.put(MARKER, new Uint8Array()),
		]) {
			const opfs = memoryOpfs();
			await arrange(opfs);
			const folder = expectOk(await open(opfs));
			expect(markerOf(opfs)).toEqual({ address: ADDRESS });
			expectOk(await folder.files.create('a.md', 'a'));
			await folder.close();
		}
	});
});

describe('a first open that cannot write its marker is refused', () => {
	/** No folder was started: nothing but an empty `.git` and maybe the marker. */
	const nothingStarted = (opfs: MemoryOpfs) =>
		expect(
			[...opfs.files(ROOT).keys()].filter(
				(path) => path !== '.git/epicenter-folder.json',
			),
		).toEqual([]);

	test('a write that fails leaves no marker, and the next open starts again', async () => {
		const opfs = memoryOpfs();
		opfs.faults.write = (path) => (path === MARKER ? 'fail' : undefined);
		expect(expectErr(await open(opfs)).name).toBe('Unavailable');
		opfs.faults.write = undefined;
		expect(opfs.files().has(MARKER)).toBe(false);
		nothingStarted(opfs);
		const folder = expectOk(await open(opfs));
		expect(markerOf(opfs)).toEqual({ address: ADDRESS });
		await folder.close();
	});

	test('a failed write whose empty file cannot be taken away is refused as unknown', async () => {
		const opfs = memoryOpfs();
		opfs.faults.write = (path) => (path === MARKER ? 'fail' : undefined);
		opfs.faults.remove = (path) => (path === MARKER ? 'fail' : undefined);
		const refused = expectErr(await open(opfs));
		opfs.faults.write = undefined;
		opfs.faults.remove = undefined;
		expect(refused.name).toBe('Unavailable');
		expect(refused.message).toContain('is unknown');
		expect(opfs.files().get(MARKER)).toEqual(new Uint8Array());
		nothingStarted(opfs);
		const folder = expectOk(await open(opfs));
		expect(markerOf(opfs)).toEqual({ address: ADDRESS });
		await folder.close();
	});

	test('a close that throws is refused whatever it published; only an empty marker is started again', async () => {
		// The close published nothing: the marker is empty, and the directory
		// holds nothing else.
		const empty = memoryOpfs();
		empty.faults.close = (path) => (path === MARKER ? 'fail' : undefined);
		expect(expectErr(await open(empty)).message).toContain('is unknown');
		empty.faults.close = undefined;
		expect(empty.files().get(MARKER)).toEqual(new Uint8Array());
		nothingStarted(empty);
		await expectOk(await open(empty)).close();
		expect(markerOf(empty)).toEqual({ address: ADDRESS });

		// The close published the marker: the next open finds the folder.
		const lost = memoryOpfs();
		lost.faults.close = (path) => (path === MARKER ? 'lost' : undefined);
		expect(expectErr(await open(lost)).name).toBe('Unavailable');
		lost.faults.close = undefined;
		nothingStarted(lost);
		expect(markerOf(lost)).toEqual({ address: ADDRESS });
		await expectOk(await open(lost)).close();

		// Another writer's marker landed instead: it is never overwritten.
		const other = memoryOpfs();
		const theirs = JSON.stringify(['development', 'local', null, id]);
		other.faults.close = (path) =>
			path === MARKER
				? { publish: encoder.encode(JSON.stringify({ address: theirs })) }
				: undefined;
		expect(expectErr(await open(other)).name).toBe('Unavailable');
		other.faults.close = undefined;
		expect(await refusedUnchanged(other)).toContain(`marked for ${theirs}`);
	});

	test('storage that cannot be reached is refused', async () => {
		const opfs = memoryOpfs();
		const refused = expectErr(
			await openFolder({
				id,
				definition,
				browser: {
					opfs: {
						...opfsEnvironment(opfs),
						getDirectory: () =>
							Promise.reject(new DOMException('Denied', 'SecurityError')),
					},
				},
			}),
		);
		expect(refused).toMatchObject({ name: 'Unavailable' });
		expect(refused.message).toContain('Denied');
		expect(opfs.directories()).toEqual([]);
	});
});

describe('an opener that does not create', () => {
	const openExisting = (opfs: MemoryOpfs) =>
		openFolder({
			id,
			definition,
			browser: {
				createIfMissing: false,
				opfs: opfsEnvironment(opfs),
			},
		});

	test('a missing folder is Absent, and nothing is created', async () => {
		const opfs = memoryOpfs();
		const absent = expectErr(await openExisting(opfs));
		expect(absent).toMatchObject({ name: 'Absent', directory: ROOT });
		expect(everything(opfs)).toEqual({ files: new Map(), directories: [] });
	});

	test('an empty directory, or one an interrupted first open left, is Absent and unchanged', async () => {
		const leftovers: ((opfs: MemoryOpfs) => Promise<void> | void)[] = [
			async (opfs) => {
				await ensureDirectory(await opfs.getDirectory(), ROOT);
			},
			(opfs) => opfs.put(MARKER, new Uint8Array()),
		];
		for (const leave of leftovers) {
			const opfs = memoryOpfs();
			await leave(opfs);
			const before = everything(opfs);
			expect(expectErr(await openExisting(opfs)).name).toBe('Absent');
			expect(everything(opfs)).toEqual(before);
		}
	});

	test('a ready folder opens as it is; the default still creates one', async () => {
		const opfs = memoryOpfs();
		const created = expectOk(await open(opfs));
		expectOk(await created.files.create('notes/a.md', '# A\n'));
		await created.close();
		const marker = opfs.files().get(MARKER);

		const existing = expectOk(await openExisting(opfs));
		expect(existing.location).toEqual({ kind: 'opfs', directory: ROOT });
		expect(
			decoder.decode(expectOk(await existing.files.read('notes/a.md')).bytes),
		).toBe('# A\n');
		await existing.close();
		expect(marker).toBeDefined();
		expect(opfs.files().get(MARKER)).toEqual(marker);
	});

	test('a pending download record is refused unchanged, with or without creating', async () => {
		const opfs = memoryOpfs();
		const pending = {
			download: {
				address: ADDRESS,
				remote: { url: 'https://example.test/data.git', branch: 'main' },
			},
		};
		opfs.put(MARKER, encoder.encode(JSON.stringify(pending)));
		expect(await refusedUnchanged(opfs)).toContain(
			'holds an unfinished download for',
		);
		const before = everything(opfs);
		expect(expectErr(await openExisting(opfs)).name).toBe('Unavailable');
		expect(everything(opfs)).toEqual(before);
	});

	test('what is not this folder is refused as Unavailable, unchanged, exactly as by the default', async () => {
		const opfs = memoryOpfs();
		opfs.put(`${ROOT}/found.txt`, encoder.encode('found'));
		const before = everything(opfs);
		const refused = expectErr(await openExisting(opfs));
		expect(refused.name).toBe('Unavailable');
		expect(refused.message).toBe(expectErr(await open(opfs)).message);
		expect(everything(opfs)).toEqual(before);
	});

	test('the decision waits for the open lock and sees what the opener ahead of it made', async () => {
		const lock = `epicenter-folder-opfs-open:${ADDRESS}`;
		const opfs = memoryOpfs();
		let release!: () => void;
		const held = navigator.locks.request(
			lock,
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		const creating = open(opfs);
		const existing = openExisting(opfs);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(opfs.directories()).toEqual([]);
		release();
		await held;
		const first = expectOk(await creating);
		const second = expectOk(await existing);
		expect(second.location).toEqual(first.location);
		await first.close();
		await second.close();

		// Ahead of a creating opener instead, it finds nothing and makes nothing.
		const fresh = memoryOpfs();
		const absent = openExisting(fresh);
		const made = open(fresh);
		expect(expectErr(await absent).name).toBe('Absent');
		await expectOk(await made).close();
		expect(markerOf(fresh)).toEqual({ address: ADDRESS });
	});
});

/** Define `globals` on `globalThis` for `work`, then put back what was there. */
async function withGlobals<T>(
	globals: PropertyDescriptorMap,
	work: () => Promise<T>,
): Promise<T> {
	const originals = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, descriptor] of Object.entries(globals)) {
		originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, {
			configurable: true,
			...descriptor,
		});
	}
	try {
		return await work();
	} finally {
		for (const [name, original] of originals) {
			if (original === undefined) Reflect.deleteProperty(globalThis, name);
			else Object.defineProperty(globalThis, name, original);
		}
	}
}

describe('the browser globals', () => {
	const writable = { value: { prototype: { createWritable() {} } } };

	test('without OPFS, writable streams, or Web Locks the default opener refuses and touches nothing', async () => {
		const opfs = memoryOpfs();
		const storage = { getDirectory: () => opfs.getDirectory() };
		const cases: [PropertyDescriptorMap, string][] = [
			[
				{ navigator: { value: { locks: createWebLocks() } } },
				'navigator.storage.getDirectory',
			],
			[
				{
					navigator: { value: { storage, locks: createWebLocks() } },
					FileSystemFileHandle: { value: { prototype: {} } },
				},
				'FileSystemFileHandle.createWritable',
			],
			[
				{ navigator: { value: { storage } }, FileSystemFileHandle: writable },
				'navigator.locks',
			],
		];
		for (const [globals, missing] of cases)
			await withGlobals(globals, async () => {
				expect(expectErr(await openFolder({ id, definition }))).toMatchObject({
					name: 'NoFileSystem',
					missing,
				});
			});
		expect(opfs.directories()).toEqual([]);
	});

	test('the default opener opens, saves, and reopens with IndexedDB absent or throwing', async () => {
		let touched = 0;
		const blocked = {
			get() {
				touched++;
				throw new DOMException('IndexedDB is blocked here', 'SecurityError');
			},
		};
		for (const indexedDb of [
			undefined,
			{ indexedDB: blocked, IDBKeyRange: blocked },
		]) {
			const opfs = memoryOpfs();
			const globals: PropertyDescriptorMap = {
				navigator: {
					value: {
						storage: { getDirectory: () => opfs.getDirectory() },
						locks: createWebLocks(),
					},
				},
				FileSystemFileHandle: writable,
				...indexedDb,
			};
			await withGlobals(globals, async () => {
				if (indexedDb === undefined)
					expect('indexedDB' in globalThis).toBe(false);
				else
					expect(
						() => (globalThis as { indexedDB?: unknown }).indexedDB,
					).toThrow();
				touched = 0;
				const options = { id, definition, browser: {} };
				const first = expectOk(await openFolder(options));
				expectOk(await first.files.create('a.md', 'saved'));
				expect((await first.git.commit()).status).toBe('committed');
				const history = expectOk(await first.git.log(10));
				expect(history).toHaveLength(1);
				await first.close();
				const again = expectOk(await openFolder(options));
				expect(
					decoder.decode(expectOk(await again.files.read('a.md')).bytes),
				).toBe('saved');
				expect(expectOk(await again.git.log(10))).toEqual(history);
				await again.close();
				expect(touched).toBe(0);
			});
			expect(markerOf(opfs)).toEqual({ address: ADDRESS });
		}
		expect(
			Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'),
		).toBeUndefined();
		expect(
			Object.getOwnPropertyDescriptor(globalThis, 'IDBKeyRange'),
		).toBeUndefined();
	});
});
