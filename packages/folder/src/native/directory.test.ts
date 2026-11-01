/**
 * Native Directory Storage Tests
 *
 * `openNativeStorage` stages each put in the directory's own `.epicenter`
 * and renames it over its path.
 *
 * Key behaviors:
 * - Staged puts live in the directory's hidden `.epicenter`; nothing is
 *   made beside the directory
 * - Two processes putting one file each land whole, and the last one wins
 * - Of two creates of one path, in one process or two, exactly one lands
 * - Within one process, two replacements over one version take turns: one
 *   lands, the other is stale
 * - A link at `.epicenter` is never followed
 */
import { expect, test } from 'bun:test';
import {
	mkdir,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { scratch } from '../git.test-support.js';
import { savesDirectory } from '../state.js';
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

test('two creates of one path in one process: one lands, one is stale, one file is there', async () => {
	const root = await scratch('native-create-race-');
	try {
		const storage = await openNativeStorage(root);
		// A first save makes the staging directory, which the race then shares.
		expectOk(await storage.put('first.md', text('first'), 'absent'));
		const outcomes = await Promise.all(
			['a', 'b'].map(async (value) =>
				expectOk(await storage.put('words/one.md', text(value), 'absent')),
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
	const root = await scratch('native-replace-race-');
	try {
		const storage = await openNativeStorage(root);
		expectOk(await storage.put('note.md', text('read'), 'absent'));
		const { sha256 } = expectOk(await storage.read('note.md'));
		const outcomes = await Promise.all(
			['a', 'b'].map(async (value) =>
				expectOk(await storage.put('note.md', text(value), { sha256 })),
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
	const root = await scratch('native-create-processes-');
	try {
		const writer = (id: number) =>
			Bun.spawn(
				[
					'bun',
					'-e',
					`
					const { openNativeStorage } = await import(${JSON.stringify(join(import.meta.dir, 'directory.ts'))});
					const [root, rounds] = process.argv.slice(-2);
					const storage = await openNativeStorage(root);
					const landed = [];
					for (let round = 0; round < Number(rounds); round++) {
						const put = await storage.put('round-' + round + '.md', new TextEncoder().encode('p${id}'), 'absent');
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

test('a put keeps its staging inside the folder and makes nothing beside it', async () => {
	const parent = await scratch('native-state-');
	const root = join(parent, 'notes');
	try {
		await mkdir(root);
		const storage = await openNativeStorage(root);
		expect(expectOk(await storage.put('todos/a.md', text('milk'), 'any'))).toBe(
			'landed',
		);
		expect(await readdir(parent)).toEqual(['notes']);
		expect((await readdir(root)).sort()).toEqual(['.epicenter', 'todos']);
		expect(await readdir(savesDirectory(root))).toEqual([]);
		const listed = expectOk(await storage.list());
		expect(listed.map(({ path }) => path)).toEqual(['todos/a.md']);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('a link at .epicenter is never followed: a put is refused and nothing lands through it', async () => {
	const parent = await scratch('native-state-link-');
	const root = join(parent, 'notes');
	const elsewhere = join(parent, 'elsewhere');
	try {
		await mkdir(root);
		await mkdir(elsewhere);
		await symlink(elsewhere, join(root, '.epicenter'));
		const storage = await openNativeStorage(root);
		const { error } = await storage.put('a.md', text('mine'), 'any');
		expect(error).not.toBeNull();
		expect(await readdir(elsewhere)).toEqual([]);
		expect(await readdir(root)).toEqual(['.epicenter']);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});
