/**
 * The Bun device store over a directory (`nodeStore`).
 *
 * Key behaviors:
 * - A save stages in the directory's own `.epicenter/saves` and makes
 *   nothing beside the directory; a replaced file keeps its permission bits
 * - Two processes replacing one file each land whole, and the last one wins
 * - Of two creates of one path, in one process or two, exactly one lands
 * - Within one process, two replacements over one version take turns: one
 *   lands, the other is stale
 * - A name only some disks hold is never made, and an existing one is
 *   replaced over its version
 * - A save across a mount point fails saying so, and leaves nothing behind
 */
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { scratch } from '../git.test-support.js';
import { savesDirectory } from '../state.js';

/** Whether the next link or rename fails as one to another file system does. */
let crossDevice = false;
const crossed = () =>
	Promise.reject(
		Object.assign(new Error('EXDEV: cross-device link not permitted'), {
			code: 'EXDEV',
		}),
	);
// A copy, since mocking the module updates the namespace imported above.
const real = { ...fs };
mock.module('node:fs/promises', () => ({
	...real,
	link: (...args: Parameters<typeof fs.link>) =>
		crossDevice ? crossed() : real.link(...args),
	rename: (...args: Parameters<typeof fs.rename>) =>
		crossDevice ? crossed() : real.rename(...args),
}));
const { nodeStore } = await import('./node-store.js');

const STORE = JSON.stringify(join(import.meta.dir, 'node-store.ts'));
const text = (value: string) => new TextEncoder().encode(value);

/** The version `store` reads at `path`, which must hold a file. */
async function versionIn(store: ReturnType<typeof nodeStore>, path: string) {
	const read = expectOk(await store.read(path));
	if (read === null) throw new Error(`nothing is at ${path}`);
	return read.version;
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
						const before = await store.read('log.txt');
						if (before.error !== null) throw new Error(JSON.stringify(before.error));
						const put = await store.write('log.txt', bytes, { sha256: before.data.version });
						if (put.error !== null) throw new Error(JSON.stringify(put.error));
						const read = await store.read('log.txt');
						if (read.error !== null) throw new Error(JSON.stringify(read.error));
						const lines = new Set(new TextDecoder().decode(read.data.bytes).split('\\n').filter(Boolean));
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

test('two creates of one path in one process: one lands, one is stale, one file is there', async () => {
	const root = await scratch('node-store-create-race-');
	try {
		const store = nodeStore(root);
		const outcomes = await Promise.all(
			['a', 'b'].map(async (value) =>
				expectOk(await store.write('words/one.md', text(value), 'absent')),
			),
		);
		expect(outcomes.toSorted()).toEqual(['landed', 'stale']);
		expect(await readdir(join(root, 'words'))).toEqual(['one.md']);
		expect(['a', 'b']).toContain(
			await readFile(join(root, 'words/one.md'), 'utf8'),
		);
		expect(await readdir(savesDirectory(root))).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('two replacements over one version in one process: one lands, one is stale', async () => {
	const root = await scratch('node-store-replace-race-');
	try {
		const store = nodeStore(root);
		expectOk(await store.write('note.md', text('read'), 'absent'));
		const sha256 = await versionIn(store, 'note.md');
		const outcomes = await Promise.all(
			['a', 'b'].map(async (value) =>
				expectOk(await store.write('note.md', text(value), { sha256 })),
			),
		);
		expect(outcomes.toSorted()).toEqual(['landed', 'stale']);
		expect(['a', 'b']).toContain(await readFile(join(root, 'note.md'), 'utf8'));
		expect(await readdir(savesDirectory(root))).toEqual([]);
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
						const put = await store.write('round-' + round + '.md', new TextEncoder().encode('p${id}'), 'absent');
						if (put.error !== null) throw new Error(JSON.stringify(put.error));
						if (put.data === 'landed') landed.push(round);
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

test('a save stages inside the folder, makes nothing beside it, and keeps a replaced file’s mode', async () => {
	const parent = await scratch('node-store-state-');
	const root = join(parent, 'notes');
	try {
		await mkdir(root);
		const store = nodeStore(root);
		expect(
			expectOk(await store.write('todos/a.md', text('milk'), 'absent')),
		).toBe('landed');
		expect(await readdir(parent)).toEqual(['notes']);
		expect((await readdir(root)).sort()).toEqual(['.epicenter', 'todos']);
		expect(await readdir(savesDirectory(root))).toEqual([]);
		const listed = expectOk(await store.list());
		expect(listed.map(({ path }) => path)).toEqual(['todos/a.md']);

		if (process.platform === 'win32') return;
		await chmod(join(root, 'todos/a.md'), 0o755);
		expect(
			expectOk(
				await store.write('todos/a.md', text('oat milk'), {
					sha256: await versionIn(store, 'todos/a.md'),
				}),
			),
		).toBe('landed');
		expect((await stat(join(root, 'todos/a.md'))).mode & 0o777).toBe(0o755);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('a name only some disks hold is never made; an existing one is replaced over its version', async () => {
	if (process.platform === 'win32') return;
	const root = await scratch('node-store-nonportable-');
	try {
		const store = nodeStore(root);
		expectErr(await store.write('aux.md', text('mine'), 'absent'));
		expect(await readdir(root)).toEqual([]);
		await writeFile(join(root, 'aux.md'), 'theirs');
		expect(
			expectOk(
				await store.write('aux.md', text('mine'), {
					sha256: await versionIn(store, 'aux.md'),
				}),
			),
		).toBe('landed');
		expect(await readFile(join(root, 'aux.md'), 'utf8')).toBe('mine');
		expectErr(await store.write('.git/config', text('x'), 'absent'));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a save across a mount point fails saying so, and leaves nothing behind', async () => {
	const root = await scratch('node-store-exdev-');
	try {
		const store = nodeStore(root);
		crossDevice = true;
		const error = expectErr(
			await store.write('mounted/a.md', text('x'), 'absent'),
		);
		crossDevice = false;
		expect(String(error.cause)).toContain(
			"cannot save across a mount point: 'mounted/a.md'",
		);
		expect(await readdir(savesDirectory(root))).toEqual([]);
		expect(await readdir(join(root, 'mounted'))).toEqual([]);
	} finally {
		crossDevice = false;
		await rm(root, { recursive: true, force: true });
	}
});
