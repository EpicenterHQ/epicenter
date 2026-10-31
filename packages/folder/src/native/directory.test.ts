/**
 * Native Directory Storage Tests
 *
 * `openNativeStorage` stages each put beside its path, as the hidden
 * `.<scratch name>.epicenter-pending`, and renames it over the path.
 *
 * Key behaviors:
 * - A landed put leaves only its file and directories; nothing is made
 *   beside the directory
 * - Two processes putting one file each land whole, and the last one wins
 * - Of puts creating one path at once, exactly one lands
 * - Opening sweeps staged files an hour old anywhere in the folder, and
 *   nothing younger or foreign: no recording in progress, nothing in `.git`
 */
import { expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { pendingName } from '../boundary.js';
import { scratch } from '../git-http.test-support.js';
import { openNativeStorage } from './directory.js';

const text = (value: string) => new TextEncoder().encode(value);

test('two processes putting one file each land whole, the last one winning', async () => {
	const ROUNDS = 30;
	const root = await scratch('native-put-race-');
	try {
		await writeFile(join(root, 'log.txt'), '');
		// Each process replaces the file with a whole value of its own and
		// reads it back: a reader never sees part of one put, or a mix.
		const writer = (id: number) =>
			Bun.spawn(
				[
					'bun',
					'-e',
					`
					const { openNativeStorage } = await import(${JSON.stringify(join(import.meta.dir, 'directory.ts'))});
					const [root, rounds] = process.argv.slice(-2);
					const storage = await openNativeStorage(root);
					for (let line = 0; line < Number(rounds); line++) {
						const bytes = new TextEncoder().encode(('p${id}-' + line + '\\n').repeat(64));
						const put = await storage.put('log.txt', bytes, 'any');
						if (put.error !== null) throw new Error(JSON.stringify(put.error));
						const read = await storage.read('log.txt');
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
		expect([`p0-${ROUNDS - 1}`, `p1-${ROUNDS - 1}`]).toContain([...lines][0]!);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);

test('a put stages beside its path and leaves only its file and directories', async () => {
	const parent = await scratch('native-state-');
	const root = join(parent, 'notes');
	try {
		await mkdir(root);
		const storage = await openNativeStorage(root);
		expect(
			expectOk(await storage.put('todos/a.md', text('milk'), 'any')).kind,
		).toBe('landed');
		expect(await readdir(parent)).toEqual(['notes']);
		expect(await readdir(root)).toEqual(['todos']);
		expect(await readdir(join(root, 'todos'))).toEqual(['a.md']);
		const listed = expectOk(await storage.list());
		expect(listed.map(({ path }) => path)).toEqual(['todos/a.md']);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('of puts creating one path at once, exactly one lands', async () => {
	const root = await scratch('native-create-race-');
	try {
		const storage = await openNativeStorage(root);
		for (let round = 0; round < 10; round++) {
			const outcomes = await Promise.all(
				[0, 1, 2, 3].map(async (writer) =>
					expectOk(
						await storage.put(
							`words/${round}.md`,
							text(`writer ${writer}`),
							'absent',
						),
					),
				),
			);
			expect(
				outcomes.filter((outcome) => outcome.kind === 'landed'),
			).toHaveLength(1);
		}
		expect(await readdir(join(root, 'words'))).toHaveLength(10);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('opening sweeps staged files an hour old anywhere, and nothing younger or foreign', async () => {
	const root = await scratch('native-sweep-');
	const engine = '0123456789abcdef0123456789abcdef';
	const staged = (age: number) =>
		pendingName(`${(Date.now() - age).toString(36)}-${engine}-0`);
	const hour = 60 * 60 * 1000;
	const swept = [staged(2 * hour), `todos/deep/${staged(2 * hour)}`];
	const kept = [
		`todos/${staged(60_000)}`,
		'recordings/.1.wav.epicenter-pending',
		'todos/.notes.pending',
		`.git/${staged(2 * hour)}`,
	];
	try {
		for (const path of [...swept, ...kept]) {
			await mkdir(join(root, path, '..'), { recursive: true });
			await writeFile(join(root, path), 'x');
		}
		await openNativeStorage(root);
		for (const path of swept)
			expect(await readFile(join(root, path)).catch(() => 'gone')).toBe('gone');
		for (const path of kept)
			expect(await readFile(join(root, path), 'utf8')).toBe('x');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
