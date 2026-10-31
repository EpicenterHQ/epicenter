/**
 * Bun Folder Tests
 *
 * `@epicenter/folder/bun` stages each save in the directory's own
 * `.epicenter` and renames it over its path.
 *
 * Key behaviors:
 * - Staged saves live in the directory's `.epicenter`, which no listing
 *   shows; nothing is made beside the directory
 * - Two processes writing one file through `write` each land whole,
 *   and the last one wins
 * - A link at `.epicenter` is never followed
 *
 * See also:
 * - `directory.test.ts` for the Folder over directory storage
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
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
import { openFolder } from './bun.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createDirectoryStorage } from './directory-store.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';
import { scratchDirectory } from './native/directory.js';

const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

test('two processes writing one file through write each land whole, the last one winning', async () => {
	const ROUNDS = 30;
	const root = await scratch('bun-write-race-');
	try {
		await writeFile(join(root, 'log.txt'), '');
		// Each process replaces the file with a whole value of its own and
		// reads it back: a reader never sees part of one write, or a mix.
		const writer = (id: number) =>
			Bun.spawn(
				[
					'bun',
					'-e',
					`
					const { openFolder } = await import(${JSON.stringify(join(import.meta.dir, 'bun.ts'))});
					const [root, rounds] = process.argv.slice(-2);
					const { data: folder, error } = await openFolder({ directory: root, tables: {} });
					if (error !== null) throw new Error(JSON.stringify(error));
					for (let line = 0; line < Number(rounds); line++) {
						const { error } = await folder.write('log.txt', ('p${id}-' + line + '\\n').repeat(64));
						if (error !== null) throw new Error(JSON.stringify(error));
						const read = await folder.read('log.txt');
						if (read.error !== null) throw new Error(JSON.stringify(read.error));
						const lines = new Set(new TextDecoder().decode(read.data).split('\\n').filter(Boolean));
						if (lines.size !== 1) throw new Error('a torn file: ' + [...lines].join(','));
					}
					await folder.close();
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

test('a save keeps its staging inside the folder, unlisted, and makes nothing beside it', async () => {
	const parent = await scratch('bun-state-');
	const root = join(parent, 'notes');
	try {
		await mkdir(root);
		const folder = expectOk(await openFolder({ directory: root, tables: {} }));
		expectOk(await folder.write('todos/a.md', 'milk'));
		expect(await readdir(parent)).toEqual(['notes']);
		expect((await readdir(root)).sort()).toEqual(['.epicenter', 'todos']);
		expect(await readdir(scratchDirectory(root))).toEqual([]);
		await folder.close();

		const storage = createDirectoryStorage({
			root,
			primitives: nodeDirectoryPrimitives,
			scratch: scratchDirectory(root),
		});
		const listed = expectOk(await storage.list());
		expect(listed.map(({ path }) => path)).toEqual(['todos/a.md']);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('a link at .epicenter is never followed: a save is refused and nothing lands through it', async () => {
	const parent = await scratch('bun-state-link-');
	const root = join(parent, 'notes');
	const elsewhere = join(parent, 'elsewhere');
	try {
		await mkdir(root);
		await mkdir(elsewhere);
		await symlink(elsewhere, join(root, '.epicenter'));
		const folder = expectOk(await openFolder({ directory: root, tables: {} }));
		const { error } = await folder.write('a.md', 'mine');
		expect(error).not.toBeNull();
		expect(await readdir(elsewhere)).toEqual([]);
		expect(await readdir(root)).toEqual(['.epicenter']);
		await folder.close();
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});
