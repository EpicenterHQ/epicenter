/**
 * The Bun device store over a directory (`nodeStore`).
 *
 * Key behaviors:
 * - A save stages beside its target in `.ep-<random>.save`, made with mode
 *   0600, and makes nothing beside the directory; a replaced file keeps its
 *   permission bits
 * - A listing never describes a reserved name (a staged save, a recording
 *   in progress), nor an older build's `.epicenter`
 * - Two processes replacing one file each land whole, and the last one wins
 * - Of two creates of one path, in one process or two, exactly one lands
 * - Within one process, two replacements over one version take turns: one
 *   lands, the other finds it moved
 * - An attachment's version is its Git LFS pointer's blob id, cached by its
 *   stamp in the hash cache the store is given, outside the folder; a file
 *   changed within the second it was hashed is hashed again
 * - A name only some disks hold is never made, and an existing one is
 *   replaced over its version
 * - A directory removed during a listing is not listed; a root removed
 *   fails the listing
 */
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { versionOf } from '../hash.js';
import { scratch } from '../scratch.test-support.js';
import { isReservedName } from '../state.js';
import type { Moved, Unavailable, Version } from './store.js';

/** Told the staged file each link or rename places, before it is placed. */
let beforeRename: ((from: string) => Promise<void>) | undefined;
/** A directory removed just before the next read of its entries. */
let removedBeforeReading: string | undefined;
// A copy, since mocking the module updates the namespace imported above.
const real = { ...fs };
mock.module('node:fs/promises', () => ({
	...real,
	readdir: async (...args: Parameters<typeof fs.readdir>) => {
		if (args[0] === removedBeforeReading) {
			removedBeforeReading = undefined;
			await real.rm(args[0], { recursive: true });
		}
		return real.readdir(...args);
	},
	link: async (...args: Parameters<typeof fs.link>) => {
		await beforeRename?.(String(args[0]));
		return real.link(...args);
	},
	rename: async (...args: Parameters<typeof fs.rename>) => {
		await beforeRename?.(String(args[0]));
		return real.rename(...args);
	},
}));
const { nodeStore, stampFileAt } = await import('./node-store.js');

/** Every reserved name left anywhere below `root`. */
async function leftovers(root: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await real.readdir(root, {
		withFileTypes: true,
		recursive: true,
	}))
		if (isReservedName(entry.name)) found.push(entry.name);
	return found;
}

const STORE = JSON.stringify(join(import.meta.dir, 'node-store.ts'));
const text = (value: string) => new TextEncoder().encode(value);

/** The version `store` reads at `path`, which must hold a file. */
async function versionIn(store: ReturnType<typeof nodeStore>, path: string) {
	const [read] = expectOk(await store.read([path]));
	if (read === undefined || 'gone' in read)
		throw new Error(`nothing is at ${path}`);
	return read.version;
}

/** Whether a put landed or found the path moved, whatever version it landed. */
function outcome(put: Result<Version | null, Moved | Unavailable>) {
	if (put.error === null) return 'landed';
	if (put.error.name === 'Moved') return 'moved';
	throw new Error(put.error.message);
}
const { chmod, mkdir, readdir, readFile, rm, stat, writeFile } = real;

test('two processes replacing one file each land whole, the last one winning', async () => {
	const ROUNDS = 30;
	const root = await scratch('node-store-put-race-');
	try {
		await writeFile(join(root, 'log.txt'), '');
		// Each process replaces the file over the version it read with a
		// whole value of its own, and reads it back: a reader never sees part
		// of one save, or a mix. A save another landed over first is stale.
		const writer = (id: number) =>
			Bun.spawn(
				[
					'bun',
					'-e',
					`
					const { nodeStore } = await import(${STORE});
					const [root, rounds] = process.argv.slice(-2);
					const store = nodeStore(root);
					for (let line = 0; line < Number(rounds); line++) {
						const bytes = new TextEncoder().encode(('p${id}-' + line + '\\n').repeat(64));
						const before = await store.read(['log.txt']);
						if (before.error !== null) throw new Error(JSON.stringify(before.error));
						const put = await store.put('log.txt', bytes, before.data[0].version);
						if (put.error !== null && put.error.name !== 'Moved') throw new Error(JSON.stringify(put.error));
						const read = await store.read(['log.txt']);
						if (read.error !== null) throw new Error(JSON.stringify(read.error));
						const lines = new Set(new TextDecoder().decode(read.data[0].bytes).split('\\n').filter(Boolean));
						if (lines.size !== 1) throw new Error('a torn file: ' + [...lines].join(','));
					}
					`,
					'--',
					root,
					String(ROUNDS),
				],
				{ stdout: 'pipe', stderr: 'inherit', env: process.env },
			);
		const writers = [writer(0), writer(1)];
		expect(await Promise.all(writers.map((child) => child.exited))).toEqual([
			0, 0,
		]);
		const lines = new Set(
			(await readFile(join(root, 'log.txt'), 'utf8'))
				.split('\n')
				.filter((line) => line !== ''),
		);
		expect([...lines]).toHaveLength(1);
		const [last] = lines;
		expect([`p0-${ROUNDS - 1}`, `p1-${ROUNDS - 1}`]).toContain(last ?? '');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);

test('two creates of one path in one process: one lands, one finds it moved, one file is there', async () => {
	const root = await scratch('node-store-create-race-');
	try {
		const store = nodeStore(root);
		const outcomes = await Promise.all(
			['a', 'b'].map(async (value) =>
				outcome(await store.put('words/one.md', text(value), null)),
			),
		);
		expect(outcomes.toSorted()).toEqual(['landed', 'moved']);
		expect(await readdir(join(root, 'words'))).toEqual(['one.md']);
		expect(['a', 'b']).toContain(
			await readFile(join(root, 'words/one.md'), 'utf8'),
		);
		expect(await leftovers(root)).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('two replacements over one version in one process: one lands, one finds it moved', async () => {
	const root = await scratch('node-store-replace-race-');
	try {
		const store = nodeStore(root);
		expectOk(await store.put('note.md', text('read'), null));
		const version = await versionIn(store, 'note.md');
		const outcomes = await Promise.all(
			['a', 'b'].map(async (value) =>
				outcome(await store.put('note.md', text(value), version)),
			),
		);
		expect(outcomes.toSorted()).toEqual(['landed', 'moved']);
		expect(['a', 'b']).toContain(await readFile(join(root, 'note.md'), 'utf8'));
		expect(await leftovers(root)).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('two processes creating one path: exactly one lands each round', async () => {
	const ROUNDS = 30;
	const root = await scratch('node-store-create-processes-');
	try {
		const writer = (id: number) =>
			Bun.spawn(
				[
					'bun',
					'-e',
					`
					const { nodeStore } = await import(${STORE});
					const [root, rounds] = process.argv.slice(-2);
					const store = nodeStore(root);
					const landed = [];
					for (let round = 0; round < Number(rounds); round++) {
						const put = await store.put('round-' + round + '.md', new TextEncoder().encode('p${id}'), null);
						if (put.error !== null && put.error.name !== 'Moved') throw new Error(JSON.stringify(put.error));
						if (put.error === null) landed.push(round);
					}
					console.log(JSON.stringify(landed));
					`,
					'--',
					root,
					String(ROUNDS),
				],
				{ stdout: 'pipe', stderr: 'inherit', env: process.env },
			);
		const writers = [writer(0), writer(1)];
		const landed = await Promise.all(
			writers.map(
				async (child) =>
					JSON.parse(await new Response(child.stdout).text()) as number[],
			),
		);
		expect(await Promise.all(writers.map((child) => child.exited))).toEqual([
			0, 0,
		]);
		// Each round's file was made by exactly one of the two, and holds its bytes.
		expect(landed.flat().toSorted((a, b) => a - b)).toEqual(
			Array.from({ length: ROUNDS }, (_, round) => round),
		);
		for (const [id, rounds] of landed.entries())
			for (const round of rounds)
				expect(await readFile(join(root, `round-${round}.md`), 'utf8')).toBe(
					`p${id}`,
				);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);

test('a save stages beside its target as a private reserved name, makes nothing else, and keeps a replaced file’s mode', async () => {
	const parent = await scratch('node-store-state-');
	const root = join(parent, 'notes');
	try {
		await mkdir(root);
		const store = nodeStore(root);
		const staged: { name: string; mode: number }[] = [];
		beforeRename = async (from) => {
			staged.push({
				name: from.slice(from.lastIndexOf('/') + 1),
				mode: (await stat(from)).mode & 0o777,
			});
		};
		expect(expectOk(await store.put('todos/a.md', text('milk'), null))).toEqual(
			await versionIn(store, 'todos/a.md'),
		);
		beforeRename = undefined;
		expect(staged).toHaveLength(1);
		expect(isReservedName(staged[0]?.name ?? '')).toBe(true);
		expect(staged[0]?.name).toEndWith('.save');
		if (process.platform !== 'win32') expect(staged[0]?.mode).toBe(0o600);
		expect(await readdir(parent)).toEqual(['notes']);
		expect(await readdir(root)).toEqual(['todos']);
		expect(await readdir(join(root, 'todos'))).toEqual(['a.md']);
		const listed = expectOk(await store.list(['']));
		expect(listed.map(({ path }) => path)).toEqual(['todos/a.md']);

		if (process.platform === 'win32') return;
		await chmod(join(root, 'todos/a.md'), 0o755);
		expect(
			expectOk(
				await store.put(
					'todos/a.md',
					text('oat milk'),
					await versionIn(store, 'todos/a.md'),
				),
			),
		).toEqual(await versionIn(store, 'todos/a.md'));
		expect((await stat(join(root, 'todos/a.md'))).mode & 0o777).toBe(0o755);
		expect(await readdir(join(root, 'todos'))).toEqual(['a.md']);
	} finally {
		beforeRename = undefined;
		await rm(parent, { recursive: true, force: true });
	}
});

test('a listing never describes a staged save, a recording in progress, or an older build’s .epicenter', async () => {
	const root = await scratch('node-store-reserved-');
	try {
		await mkdir(join(root, 'recordings'), { recursive: true });
		await mkdir(join(root, '.epicenter/saves'), { recursive: true });
		await writeFile(join(root, 'recordings/take.webm'), 'audio');
		await writeFile(join(root, 'recordings/.ep-k3j9x2ab-next.recording'), 'x');
		await writeFile(join(root, '.ep-0123abcd.save'), 'half');
		await writeFile(join(root, '.epicenter/synced.json'), '{}');
		await writeFile(join(root, '.DS_Store'), 'finder');
		const store = nodeStore(root);
		expect(
			expectOk(await store.list(['']))
				.map(({ path }) => path)
				.sort(),
		).toEqual(['.DS_Store', 'recordings/take.webm']);
		expect(
			expectOk(await store.list(['recordings/.ep-k3j9x2ab-next.recording'])),
		).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a name only some disks hold is never made; an existing one is replaced over its version', async () => {
	if (process.platform === 'win32') return;
	const root = await scratch('node-store-nonportable-');
	try {
		const store = nodeStore(root);
		expectErr(await store.put('aux.md', text('mine'), null));
		expect(await readdir(root)).toEqual([]);
		await writeFile(join(root, 'aux.md'), 'theirs');
		expect(
			expectOk(
				await store.put(
					'aux.md',
					text('mine'),
					await versionIn(store, 'aux.md'),
				),
			),
		).toEqual(await versionIn(store, 'aux.md'));
		expect(await readFile(join(root, 'aux.md'), 'utf8')).toBe('mine');
		expectErr(await store.put('.git/config', text('x'), null));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a directory removed during a listing is not listed; a root removed fails the listing', async () => {
	const root = await scratch('node-store-list-removed-');
	try {
		await writeFile(join(root, 'keep.md'), 'kept');
		await mkdir(join(root, 'gone'));
		await writeFile(join(root, 'gone/note.md'), 'gone');
		const store = nodeStore(root);
		removedBeforeReading = join(root, 'gone');
		const listed = expectOk(await store.list(['']));
		expect(listed.map(({ path }) => path)).toEqual(['keep.md']);

		removedBeforeReading = root;
		expectErr(await store.list(['']));
	} finally {
		removedBeforeReading = undefined;
		await rm(root, { recursive: true, force: true });
	}
});

test('a large file is named by its SHA-256, hashed once, and again when it changes within the second it was hashed', async () => {
	const root = await scratch('node-store-stamps-');
	const cache = `${root}-hashes.json`;
	const cached_ = () => nodeStore(root, { hashes: stampFileAt(cache) });
	const one = new Uint8Array(70_000).fill(1);
	const two = new Uint8Array(70_000).fill(2);
	try {
		await writeFile(join(root, 'take.webm'), one);
		const listedOnce = expectOk(await cached_().list(['']));
		expect(listedOnce).toEqual([
			{
				path: 'take.webm',
				version: await versionOf(one),
				size: 70_000,
			},
		]);
		const cached = JSON.parse(await readFile(cache, 'utf8'));
		expect(Object.keys(cached)).toEqual(['take.webm']);
		// Nothing of the cache is in the folder.
		expect(await readdir(root)).toEqual(['take.webm']);
		// Rewritten within the same second, to the same length: the stamp's
		// time could match, so the racy entry is hashed again, never trusted.
		await writeFile(join(root, 'take.webm'), two);
		const [again] = expectOk(await cached_().list(['']));
		expect(again?.version).toBe(await versionOf(two));
		// A cache that holds a hash under an old enough stamp answers without reading.
		const stats = await stat(join(root, 'take.webm'), { bigint: true });
		await writeFile(
			cache,
			JSON.stringify({
				'take.webm': {
					stamp: `${stats.size}:${stats.mtimeNs}:${stats.ino}`,
					version: 'f'.repeat(64),
					hashed: Number(stats.mtimeNs / 1_000_000n) + 5000,
				},
			}),
		);
		const [trusted] = expectOk(await cached_().list(['']));
		expect(trusted?.version as string).toBe('f'.repeat(64));
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(cache, { force: true });
	}
});
