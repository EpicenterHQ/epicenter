/**
 * Capture Stat Cache Tests
 *
 * A capture skips reading a file whose listing still matches what the stat
 * cache recorded when its bytes were last read (`capture-cache.ts`). The
 * cache only saves reads: with it, without it, deleted, or corrupted, every
 * status and commit is the same.
 *
 * Key behaviors:
 * - Random edits, statuses, commits, clock steps, reopenings, and lost or
 *   corrupted caches give the same changes and trees as a folder with no
 *   cache, on a fine clock and on one that keeps two-second times
 * - A same-size edit in the same timestamp as the listing, landing between a
 *   file's read and the next capture, is read again (the racy rule)
 * - A file edited after the listing is committed as listed, then as edited
 * - Once the cache holds a folder, a commit of one changed file reads that
 *   file, hashes a handful of objects, and writes four
 * - A cache that does not check is no cache, and its format has no migration
 * - On a native folder, a same-size edit whose modification time is set back
 *   is still read: the inode and change time differ
 *
 * See also:
 * - `history.test.ts` for the coordinator these captures run in
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import {
	type FolderStorage,
	type LockingStorage,
	mayHaveChanged,
} from '../boundary.js';
import { rawBrowserFolder } from '../browser-storage.test-support.js';
import { directoryStorage } from '../bun.js';
import { nodeDirectoryPrimitives } from '../directory-node.js';
import { scratch } from '../git-http.test-support.js';
import { overwrite } from '../put.test-support.js';
import type { GitBackend } from './backend.js';
import {
	CAPTURE_CACHE_PATH,
	entryFor,
	parseCache,
	RACY_MS,
	serializeCache,
} from './capture-cache.js';
import { createHistory } from './history.js';
import { nativeHistory } from './native-history.js';
import { createGitRunner } from './native-host.js';
import { commitTree, hasObject, readTreeFiles } from './objects.js';

const author = { name: 'Cache', email: 'cache@example.test' };
const OID = 'a'.repeat(40);

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0)) await step();
});

/**
 * Storage whose listing carries modification times from a clock the test
 * moves, kept in steps of `granularity` milliseconds as a file system keeps
 * them. Every change through it, including Sync's, stamps the path with the
 * clock's time, as a real file system does. `hooks` run after the listing
 * and after each read, where a test plays another writer.
 */
function clocked(
	storage: LockingStorage,
	clock: { now: number },
	granularity: number,
) {
	const modified = new Map<string, number>();
	const counts = { reads: 0 };
	const hooks: {
		afterList?: () => Promise<void>;
		afterRead?: (path: string) => Promise<void>;
	} = {};
	const stamped = (held: FolderStorage): FolderStorage => ({
		...held,
		async put(path, bytes, ifMatch) {
			const result = await held.put(path, bytes, ifMatch);
			if (mayHaveChanged(result))
				modified.set(path, Math.floor(clock.now / granularity) * granularity);
			return result;
		},
	});
	const wrapped: LockingStorage = {
		...stamped(storage),
		async list() {
			const listedAt = clock.now;
			const listed = await storage.list();
			if (listed.error !== null) return listed;
			// Stats as the listing found them, before any later writer.
			const files = listed.data.files.map((file) => ({
				...file,
				modified: modified.get(file.path),
			}));
			const hook = hooks.afterList;
			hooks.afterList = undefined;
			await hook?.();
			return Ok({ ...listed.data, listedAt, files });
		},
		async read(path) {
			counts.reads++;
			const read = await storage.read(path);
			await hooks.afterRead?.(path);
			return read;
		},
		lock: (work) => storage.lock((held) => work(stamped(held))),
	};
	return { storage: wrapped, counts, hooks };
}

/** `backend` without its stat cache. */
const withoutCache = (backend: GitBackend): GitBackend =>
	new Proxy(backend, {
		get: (target, key) =>
			key === 'captureCache' ? undefined : Reflect.get(target, key),
	});

let folders = 0;

/** A browser folder on the test clock, with its history. */
async function folder({
	clock,
	granularity,
	cache = true,
}: {
	clock: { now: number };
	granularity: number;
	cache?: boolean;
}) {
	const id = `cache-${folders++}`;
	const raw = await rawBrowserFolder({ id });
	const real = await raw.backend();
	const backend = cache ? real : withoutCache(real);
	const files = clocked(raw.boundary, clock, granularity);
	let history = createHistory({ backend, boundary: files.storage, author });
	cleanup.push(() => history.close());
	const objects = () =>
		[...raw.opfs.files(id).keys()].filter((path) =>
			path.startsWith('.git/objects/'),
		).length;
	return {
		files,
		raw,
		backend,
		get history() {
			return history;
		},
		/** A new handle on the same folder, which reads the stored cache afresh. */
		async reopen() {
			await history.close();
			history = createHistory({ backend, boundary: files.storage, author });
			cleanup.push(() => history.close());
		},
		write: (path: string, text: string | null) =>
			overwrite(files.storage, path, text),
		/** The files of the branch head, by path and blob. */
		async head() {
			const oid = await real.readBranch();
			if (oid === undefined) return undefined;
			return real.withObjects(async (access) =>
				Object.fromEntries(
					[...(await readTreeFiles(access, await commitTree(access, oid)))].map(
						([path, file]) => [path, file.oid],
					),
				),
			);
		},
		/** The head's paths whose blob is not stored. */
		async missing() {
			const files = (await this.head()) ?? {};
			return real.withObjects(async (access) => {
				const missing: string[] = [];
				for (const [path, oid] of Object.entries(files))
					if (!(await hasObject(access, oid))) missing.push(path);
				return missing;
			});
		},
		cachePath: `${id}/.git/${CAPTURE_CACHE_PATH}`,
		objects,
	};
}

/** A small deterministic generator, so a failing sequence can be replayed. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PATHS = ['a.md', 'b.md', 'dir/c.md', 'dir/d.md', 'e.md'];
// Same-size contents, so only the bytes tell them apart, and one longer.
const CONTENTS = ['aaaa', 'bbbb', 'cccc', 'ddddd'];
const STEPS = [0, 0, 1, 500, 2000, RACY_MS + 1, 10_000];

for (const granularity of [1, 2000])
	test(`random edits commit the same trees with and without the cache (${granularity} ms times)`, async () => {
		for (let seed = 1; seed <= 12; seed++) {
			const next = random(seed * 7919 + granularity);
			const pick = <T>(items: readonly T[]) =>
				items[Math.floor(next() * items.length)]!;
			const clock = { now: 1_700_000_000_000 };
			const cached = await folder({ clock, granularity });
			const plain = await folder({ clock, granularity, cache: false });
			const log: string[] = [];
			for (let step = 0; step < 60; step++) {
				const roll = next();
				const both = async (
					work: (side: typeof cached) => Promise<unknown>,
				) => {
					await work(cached);
					await work(plain);
				};
				if (roll < 0.35) {
					const path = pick(PATHS);
					const text = next() < 0.15 ? null : pick(CONTENTS);
					log.push(`write ${path} ${text}`);
					await both((side) => side.write(path, text));
				} else if (roll < 0.4) {
					const text = next() < 0.5 ? null : 'e.md\n';
					log.push(`.gitignore ${text}`);
					await both((side) => side.write('.gitignore', text));
				} else if (roll < 0.6) {
					const by = pick(STEPS);
					log.push(`clock +${by}`);
					clock.now += by;
				} else if (roll < 0.72) {
					log.push('status');
					const [a, b] = [
						await cached.history.status(),
						await plain.history.status(),
					];
					expect(a.error, log.join('\n')).toBeNull();
					expect(a.data?.changes, log.join('\n')).toEqual(b.data?.changes);
				} else if (roll < 0.92) {
					log.push('commit');
					const [a, b] = [
						await cached.history.commit(),
						await plain.history.commit(),
					];
					expect(a.status, log.join('\n')).toBe(b.status);
					expect(await cached.head(), log.join('\n')).toEqual(
						await plain.head(),
					);
					expect(await cached.missing(), log.join('\n')).toEqual([]);
				} else if (roll < 0.96) {
					log.push('reopen');
					await cached.reopen();
				} else {
					const lost = next() < 0.5;
					log.push(lost ? 'cache deleted' : 'cache corrupted');
					if (lost) cached.raw.opfs.drop(cached.cachePath);
					else {
						const stored = cached.raw.opfs.files().get(cached.cachePath);
						if (stored !== undefined) {
							const bad = stored.slice();
							bad[bad.length - 3]! ^= 1;
							cached.raw.opfs.put(cached.cachePath, bad);
						}
					}
					await cached.reopen();
				}
			}
			// Whatever the sequence left, a final commit agrees.
			clock.now += 10_000;
			expect((await cached.history.commit()).status).toBe(
				(await plain.history.commit()).status,
			);
			expect(await cached.head()).toEqual(await plain.head());
		}
	}, 120_000);

test('a same-size edit in the listing timestamp, after the read, is read again', async () => {
	const clock = { now: 1_700_000_000_000 };
	const side = await folder({ clock, granularity: 2000 });
	await side.write('note.md', 'aaaa');
	clock.now += 10_000;
	expect((await side.history.commit()).status).toBe('committed');
	clock.now += 10_000;
	// Edited, then captured in the same two-second step; once the capture
	// has read it, it changes again to bytes of the same size, still in
	// that step.
	await side.write('note.md', 'bbbb');
	side.files.hooks.afterRead = async (path) => {
		if (path !== 'note.md') return;
		side.files.hooks.afterRead = undefined;
		await side.write('note.md', 'cccc');
	};
	expect((await side.history.commit()).status).toBe('committed');
	const committed = await side.head();
	// Long after: its stat still says what the listing said.
	clock.now += 10_000;
	expect((await side.history.commit()).status).toBe('committed');
	const latest = await side.head();
	expect(latest?.['note.md']).not.toBe(committed?.['note.md']);
	expect(expectText(await side.files.storage.read('note.md'))).toBe('cccc');
});

function expectText(read: Awaited<ReturnType<FolderStorage['read']>>) {
	return new TextDecoder().decode(expectOk(read).bytes);
}

test('a file edited after the listing is committed as listed, then as edited', async () => {
	const clock = { now: 1_700_000_000_000 };
	const side = await folder({ clock, granularity: 1 });
	await side.write('kept.md', 'aaaa');
	await side.write('other.md', 'xxxx');
	clock.now += 10_000;
	await side.history.commit();
	clock.now += 10_000;
	// Recorded with its stat: the cache now vouches for both.
	await side.history.commit();
	const before = await side.head();
	clock.now += 10_000;
	await side.write('other.md', 'yyyy');
	side.files.hooks.afterList = () => side.write('kept.md', 'bbbb');
	expect((await side.history.commit()).status).toBe('committed');
	const listed = await side.head();
	expect(listed?.['kept.md']).toBe(before?.['kept.md']);
	expect(listed?.['other.md']).not.toBe(before?.['other.md']);
	expect((await side.history.commit()).status).toBe('committed');
	expect((await side.head())?.['kept.md']).not.toBe(before?.['kept.md']);
});

test('a commit of one changed file reads it alone and writes four objects', async () => {
	const clock = { now: 1_700_000_000_000 };
	const side = await folder({ clock, granularity: 1 });
	for (let index = 0; index < 300; index++)
		await side.write(`rows/${index}.md`, `row ${index}\n`);
	expect((await side.history.commit()).status).toBe('committed');
	clock.now += 10_000;
	// Every file was too new to vouch for at the first commit.
	side.files.counts.reads = 0;
	expect((await side.history.commit()).status).toBe('unchanged');
	expect(side.files.counts.reads).toBe(300);

	side.files.counts.reads = 0;
	expect(expectOk(await side.history.status()).changes).toEqual([]);
	expect((await side.history.commit()).status).toBe('unchanged');
	expect(side.files.counts.reads).toBe(0);

	await side.write('rows/7.md', 'row 7, edited\n');
	side.files.counts.reads = 0;
	const objects = side.objects();
	const hashes = countDigests('SHA-1');
	expect(expectOk(await side.history.status()).changes).toEqual([
		{ path: 'rows/7.md', kind: 'modify' },
	]);
	expect((await side.history.commit()).status).toBe('committed');
	hashes.stop();
	// Read by the status and again by the commit, since it is too new to
	// vouch for; nothing else is read.
	expect(side.files.counts.reads).toBe(2);
	// The blob, `rows`, the root tree, and the commit.
	expect(side.objects() - objects).toBe(4);
	// Its blob, twice, and the trees and commits read or written: a
	// handful, never one per file.
	expect(hashes.count).toBeLessThan(30);
});

/** Count `crypto.subtle` digests of `algorithm` until `stop`. */
function countDigests(algorithm: string) {
	const subtle = crypto.subtle as { digest: SubtleCrypto['digest'] };
	const original = subtle.digest;
	const counter = {
		count: 0,
		stop: () => {
			subtle.digest = original;
		},
	};
	subtle.digest = function (this: SubtleCrypto, name, data) {
		const asked = typeof name === 'string' ? name : name.name;
		if (asked === algorithm) counter.count++;
		return original.call(this, name, data);
	} as SubtleCrypto['digest'];
	return counter;
}

test('a cache that does not check is no cache', async () => {
	const entries = new Map([
		['a.md', { size: 4, modified: 1000, stamp: '1:2:3', oid: OID }],
		['b c.md', { size: 5, modified: 2000, stamp: undefined, oid: OID }],
	]);
	const bytes = await serializeCache(entries);
	expect(await parseCache(bytes)).toEqual(entries);
	for (let at = 0; at < bytes.length; at += 7) {
		const flipped = bytes.slice();
		flipped[at]! ^= 1;
		expect((await parseCache(flipped)).size).toBe(0);
	}
	expect((await parseCache(bytes.subarray(0, bytes.length - 1))).size).toBe(0);
	expect((await parseCache(undefined)).size).toBe(0);
	const other = new TextDecoder()
		.decode(bytes)
		.replace('capture cache 1', 'capture cache 2');
	expect((await parseCache(new TextEncoder().encode(other))).size).toBe(0);
});

test('only a time older than its listing by the racy margin is remembered', () => {
	const listedAt = 1_000_000;
	const at = (modified: number | undefined) =>
		entryFor({ size: 1, modified }, listedAt, OID);
	expect(at(listedAt - RACY_MS - 1)).toBeDefined();
	expect(at(listedAt - RACY_MS)).toBeUndefined();
	expect(at(listedAt)).toBeUndefined();
	expect(at(listedAt + 60_000)).toBeUndefined();
	expect(at(undefined)).toBeUndefined();
	expect(at(0)).toBeUndefined();
	expect(at(Number.NaN)).toBeUndefined();
	expect(entryFor({ size: 1, modified: 0 }, undefined, OID)).toBeUndefined();
});

test('a native same-size edit whose time is set back is read again', async () => {
	const root = await scratch('capture-cache-');
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const folderRoot = join(root, 'folder');
	await mkdir(folderRoot);
	const path = join(folderRoot, 'note.md');
	await writeFile(path, 'aaaa');
	await writeFile(join(folderRoot, 'other.md'), 'other');
	// Well before the listing, so the cache may vouch for both.
	const old = new Date(Date.now() - 60_000);
	await utimes(path, old, old);
	await utimes(join(folderRoot, 'other.md'), old, old);
	const storage = directoryStorage(folderRoot);
	const counts = { reads: 0 };
	const boundary: LockingStorage = {
		...storage,
		read(file) {
			counts.reads++;
			return storage.read(file);
		},
	};
	const history = (
		await nativeHistory({
			rootPath: folderRoot,
			host: {
				run: createGitRunner(folderRoot),
				files: nodeDirectoryPrimitives,
			},
			boundary,
			author,
		})({ landed: () => {} })
	)();
	cleanup.push(() => history.close());
	expect((await history.commit()).status).toBe('committed');
	counts.reads = 0;
	expect((await history.commit()).status).toBe('unchanged');
	expect(counts.reads).toBe(0);
	// The same size and the same modification time: only the change time
	// tells.
	const { mtime } = await stat(path);
	await writeFile(path, 'bbbb');
	await utimes(path, mtime, mtime);
	expect((await history.commit()).status).toBe('committed');
	expect(counts.reads).toBe(1);
});
