/**
 * Native Directory Storage Tests
 *
 * `openNativeStorage` stages each put in the directory's own `.epicenter`
 * and renames it over its path.
 *
 * Key behaviors:
 * - Staged puts live in the directory's `.epicenter`, which no listing
 *   shows; nothing is made beside the directory
 * - Two processes putting one file each land whole, and the last one wins
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
import { scratch } from '../git-http.test-support.js';
import { openNativeStorage, scratchDirectory } from './directory.js';

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

test('a put keeps its staging inside the folder, unlisted, and makes nothing beside it', async () => {
	const parent = await scratch('native-state-');
	const root = join(parent, 'notes');
	try {
		await mkdir(root);
		const storage = await openNativeStorage(root);
		expect(
			expectOk(await storage.put('todos/a.md', text('milk'), 'any')).kind,
		).toBe('landed');
		expect(await readdir(parent)).toEqual(['notes']);
		expect((await readdir(root)).sort()).toEqual(['.epicenter', 'todos']);
		expect(await readdir(scratchDirectory(root))).toEqual([]);
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
