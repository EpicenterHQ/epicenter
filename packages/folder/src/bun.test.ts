/**
 * Bun Save Lock Tests
 *
 * `@epicenter/folder/bun` takes the directory's save lock, an exclusive SQLite
 * transaction on `.epicenter/save-lock` inside it, around each check and
 * rename, as the desktop shell does (ADR-0562). Saves from separate
 * processes take turns, so none is lost.
 *
 * Key behaviors:
 * - The save lock and staged saves live in the directory's `.epicenter`,
 *   which no listing shows; nothing is made beside the directory
 * - A save waits while another process holds the save lock, then replaces
 *   what that process saved
 * - Two processes writing one file through `write` each land whole,
 *   and the last one wins
 * - A save lock not taken in time is `NothingChanged`, so the put it guarded
 *   is `Io`, never `Unconfirmed`, and leaves no staged file or new directory
 *
 * See also:
 * - `directory.test.ts` for the Folder over directory storage
 * - `registry_tests.rs` in `tauri-plugin-epicenter-folder`, where a shell
 *   save waits for a Bun process holding the same lock
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { holdingFileLock, openFolder } from './bun.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createDirectoryStorage } from './directory-store.js';
import { NothingChanged } from './errors.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';
import { hashBytes } from './hash.js';
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

/** The save lock inside the directory at `root`. */
const saveLock = (root: string) => join(root, '.epicenter', 'save-lock');

/** Each line a child process prints, in order. */
function lines(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	return async function next(): Promise<string> {
		for (;;) {
			const end = buffered.indexOf('\n');
			if (end >= 0) {
				const line = buffered.slice(0, end);
				buffered = buffered.slice(end + 1);
				return line;
			}
			const { value, done } = await reader.read();
			if (done) throw new Error(`the process ended after: ${buffered}`);
			buffered += decoder.decode(value, { stream: true });
		}
	};
}

test('a save waits for another process holding the save lock, then replaces its save', async () => {
	const root = await scratch('bun-save-lock-');
	const lock = saveLock(root);
	const target = join(root, 'note.txt');
	try {
		await writeFile(target, 'old');
		const folder = expectOk(await openFolder({ directory: root, tables: {} }));

		// Another process takes the lock as the shell does, and on a line from
		// stdin lands its own save, then lets go.
		const other = Bun.spawn(
			[
				'bun',
				'-e',
				`
				import { Database } from 'bun:sqlite';
				import { mkdirSync, writeFileSync } from 'node:fs';
				import { dirname } from 'node:path';
				const [lock, target] = process.argv.slice(-2);
				mkdirSync(dirname(lock), { recursive: true });
				const database = new Database(lock, { create: true });
				database.run('PRAGMA busy_timeout = 0');
				database.run('BEGIN EXCLUSIVE');
				console.log('locked');
				for await (const _ of console) {
					writeFileSync(target, 'theirs');
					database.run('ROLLBACK');
					database.close();
					console.log('released');
					process.exit(0);
				}
				`,
				'--',
				lock,
				target,
			],
			{ stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
		);
		const said = lines(other.stdout);
		expect(await said()).toBe('locked');

		let settled = false;
		const saving = folder.write('note.txt', 'ours').finally(() => {
			settled = true;
		});
		await Bun.sleep(200);
		expect(settled).toBe(false);
		expect(await readFile(target, 'utf8')).toBe('old');

		other.stdin.write('go\n');
		await other.stdin.flush();
		expect(await said()).toBe('released');
		await other.exited;

		// Its unconditional put waited for the lock, then replaced theirs.
		expectOk(await saving);
		expect(await readFile(target, 'utf8')).toBe('ours');
		await folder.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
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

test('a save lock not taken in time changes nothing, so the put it guarded is Io', async () => {
	const root = await scratch('bun-lock-refused-');
	const lock = saveLock(root);
	try {
		const held = Promise.withResolvers<void>();
		const holding = holdingFileLock(
			lock,
			{ waitMs: 0, held: 'first' },
			() => held.promise,
		);
		// The second holder in this process would wait its turn; another
		// process's connection is refused at once.
		const refused = Bun.spawn(
			[
				'bun',
				'-e',
				`
				const { holdingFileLock } = await import(${JSON.stringify(join(import.meta.dir, 'bun.ts'))});
				const { NothingChanged } = await import(${JSON.stringify(join(import.meta.dir, 'errors.ts'))});
				await holdingFileLock(process.argv.at(-1), { waitMs: 0, held: 'busy' }, async () => {}).then(
					() => console.log('taken'),
					(cause) => console.log(cause instanceof NothingChanged ? 'NothingChanged: ' + cause.message : 'other'),
				);
				`,
				'--',
				lock,
			],
			{ stdout: 'pipe', stderr: 'inherit' },
		);
		expect((await new Response(refused.stdout).text()).trim()).toBe(
			'NothingChanged: busy',
		);
		held.resolve();
		await holding;

		// A put whose guarded rename was refused that way reports `Io`.
		const staging = scratchDirectory(root);
		const storage = createDirectoryStorage({
			root,
			primitives: {
				...nodeDirectoryPrimitives,
				rename: async () => {
					throw new NothingChanged('the save lock was held');
				},
			},
			scratch: staging,
		});
		const put = await storage.put(
			'new/deep/a.md',
			new TextEncoder().encode('x'),
			'absent',
		);
		expect(put.error).toMatchObject({ name: 'Io', operation: 'write' });
		await writeFile(join(root, 'old.md'), 'old');
		const removal = await createDirectoryStorage({
			root,
			primitives: {
				...nodeDirectoryPrimitives,
				remove: async () => {
					throw new NothingChanged('the save lock was held');
				},
			},
			scratch: staging,
		}).put('old.md', null, {
			sha256: await hashBytes(new TextEncoder().encode('old')),
		});
		expect(removal.error).toMatchObject({ name: 'Io', operation: 'remove' });
		expect(await readFile(join(root, 'old.md'), 'utf8')).toBe('old');
		// Nothing of the refused put is left: no staged file, no directory.
		expect(await readdir(staging)).toEqual([]);
		expect(await readdir(root)).not.toContain('new');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('a save keeps its lock and staging inside the folder, unlisted, and makes nothing beside it', async () => {
	const parent = await scratch('bun-state-');
	const root = join(parent, 'notes');
	try {
		await mkdir(root);
		const folder = expectOk(await openFolder({ directory: root, tables: {} }));
		expectOk(await folder.write('todos/a.md', 'milk'));
		expect(await readdir(parent)).toEqual(['notes']);
		expect((await readdir(root)).sort()).toEqual(['.epicenter', 'todos']);
		expect((await lstat(saveLock(root))).isFile()).toBe(true);
		expect(await readdir(scratchDirectory(root))).toEqual([]);
		await folder.close();

		const storage = createDirectoryStorage({
			root,
			primitives: nodeDirectoryPrimitives,
			scratch: scratchDirectory(root),
		});
		const listed = expectOk(await storage.list());
		expect(listed.directories).toEqual(['todos']);
		expect(listed.files.map(({ path }) => path)).toEqual(['todos/a.md']);
		expect(expectOk(await storage.children('')).directories).toEqual(['todos']);
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
