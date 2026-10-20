/**
 * Bun Save Lock Tests
 *
 * `@epicenter/folder/bun` takes the directory's save lock, an exclusive SQLite
 * transaction on `.<name>.epicenter-save-lock` beside it, around each check
 * and rename, as the desktop shell does (ADR-0562). Saves from separate
 * processes take turns, so none is lost.
 *
 * Key behaviors:
 * - A save waits while another process holds the save lock, then finds its
 *   put stale against what that process saved, reads again, and merges
 * - Two processes appending to one file through `files.write` keep every
 *   line once
 * - A save lock not taken in time is `NothingChanged`, so the put it guarded
 *   is `Io`, never `Unconfirmed`, and leaves no staged file or new directory
 * - The CLI's history saves and syncs staging beside the folder, as a Bun
 *   folder does, sweeps what a stopped save left there, and leaves
 *   `.git/epicenter/scratch` as it is
 *
 * See also:
 * - `native/bun.test.ts` for the rest of the Bun `Folder`
 * - `registry_tests.rs` in `tauri-plugin-epicenter-folder`, where a shell
 *   save waits for a Bun process holding the same lock
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	formatDefinition,
	holdingFileLock,
	openFolder,
	runHistory,
} from './bun.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createDirectoryStorage } from './directory-store.js';
import { NothingChanged } from './errors.js';
import {
	GIT_ENV,
	git,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';
import { hashBytes } from './hash.js';

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

/** `.<name>.epicenter-<kind>` beside the directory at `root`. */
const besideRoot = (root: string, kind: string) =>
	join(dirname(root), `.${basename(root)}.epicenter-${kind}`);

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

test('a save waits for another process holding the save lock, then merges with its save', async () => {
	const root = await scratch('bun-save-lock-');
	const lock = join(dirname(root), `.${basename(root)}.epicenter-save-lock`);
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
				import { writeFileSync } from 'node:fs';
				const [lock, target] = process.argv.slice(-2);
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
		const saving = folder.files.write('note.txt', 'old', 'ours').finally(() => {
			settled = true;
		});
		await Bun.sleep(200);
		expect(settled).toBe(false);
		expect(await readFile(target, 'utf8')).toBe('old');

		other.stdin.write('go\n');
		await other.stdin.flush();
		expect(await said()).toBe('released');
		await other.exited;

		// Its put, guarded by what it read, was stale: it read theirs and won
		// the line both changed.
		expectOk(await saving);
		expect(await readFile(target, 'utf8')).toBe('ours');
		await folder.close();
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(lock, { force: true });
		await rm(besideRoot(root, 'scratch'), { recursive: true, force: true });
	}
});

test('two processes appending to one file through files.write keep every line once', async () => {
	const ROUNDS = 30;
	const root = await scratch('bun-write-race-');
	try {
		await writeFile(join(root, 'log.txt'), '');
		// Each process appends its own lines through \`files.write\`: read the
		// file, then save the change from what it read to that plus a line. A
		// put the other process overtook reads and merges again, keeping both
		// lines.
		const appender = (id: number) =>
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
						const read = await folder.files.read('log.txt');
						if (read.error !== null) throw new Error(JSON.stringify(read.error));
						const text = await read.data.content.text();
						const { error } = await folder.files.write('log.txt', text, text + 'p${id}-' + line + '\\n');
						if (error !== null) throw new Error(JSON.stringify(error));
					}
					await folder.close();
					`,
					'--',
					root,
					String(ROUNDS),
				],
				{ stdout: 'pipe', stderr: 'inherit', env: process.env },
			);
		const appenders = [appender(0), appender(1)];
		expect(await Promise.all(appenders.map((child) => child.exited))).toEqual([
			0, 0,
		]);
		const lines = (await readFile(join(root, 'log.txt'), 'utf8'))
			.split('\n')
			.filter((line) => line !== '');
		for (const id of [0, 1])
			expect(lines.filter((line) => line.startsWith(`p${id}-`))).toEqual(
				Array.from({ length: ROUNDS }, (_, line) => `p${id}-${line}`),
			);
		expect(lines).toHaveLength(2 * ROUNDS);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(besideRoot(root, 'save-lock'), { force: true });
		await rm(besideRoot(root, 'scratch'), { recursive: true, force: true });
	}
}, 60_000);

test('a save lock not taken in time changes nothing, so the put it guarded is Io', async () => {
	const root = await scratch('bun-lock-refused-');
	const lock = join(dirname(root), `.${basename(root)}.epicenter-save-lock`);
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
		const staging = besideRoot(root, 'scratch');
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
			null,
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
		}).put('old.md', null, await hashBytes(new TextEncoder().encode('old')));
		expect(removal.error).toMatchObject({ name: 'Io', operation: 'remove' });
		expect(await readFile(join(root, 'old.md'), 'utf8')).toBe('old');
		// Nothing of the refused put is left: no staged file, no directory.
		expect(await readdir(staging)).toEqual([]);
		expect(await readdir(root)).not.toContain('new');
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(lock, { force: true });
		await rm(besideRoot(root, 'scratch'), { recursive: true, force: true });
	}
});

test("the CLI's history stages beside the folder, sweeps what a stopped save left there, and leaves .git/epicenter/scratch alone", async () => {
	const parent = await scratch('bun-history-scratch-');
	const bare = join(parent, 'remote.git');
	const root = join(parent, 'folder');
	const other = join(parent, 'other');
	const author = { name: 'Notes', email: 'notes@example.test' };
	try {
		await git(
			parent,
			'init',
			'--quiet',
			'--bare',
			'--initial-branch=main',
			bare,
		);
		await initWithOrigin(root, bare);
		await writeFile(
			join(root, 'epicenter.json'),
			formatDefinition(defineFolder({ tables: {} })),
		);
		await writeFile(join(root, 'kept.md'), 'kept\n');
		// What an older version staged in `.git` is a person's to remove.
		const oldScratch = join(root, '.git/epicenter/scratch');
		const oldName = `${(1).toString(36)}-${'0'.repeat(32)}-0`;
		await mkdir(oldScratch, { recursive: true });
		await writeFile(join(oldScratch, oldName), 'older version');
		// A save that stopped an hour ago left a file beside the folder, in a
		// scratch directory an older version made open to everyone.
		const staging = besideRoot(root, 'scratch');
		const stale = `${(Date.now() - 2 * 60 * 60 * 1000).toString(36)}-${'0'.repeat(32)}-0`;
		await mkdir(staging);
		await chmod(staging, 0o755);
		await writeFile(join(staging, stale), 'stopped');

		const saved = await runHistory(
			root,
			{ op: 'saveVersion', message: 'Start' },
			{ author },
		);
		expect(saved.result).toMatchObject({ status: 'committed' });
		expect(await readdir(staging)).toEqual([]);
		const pushed = await runHistory(root, { op: 'sync' }, { author });
		expect(expectOk(pushed.result as never)).toMatchObject({ kind: 'synced' });

		// Another clone adds a file; the sync lands it through the storage.
		await git(parent, 'clone', '--quiet', bare, other);
		await writeFile(join(other, 'theirs.md'), 'theirs\n');
		await git(other, 'add', 'theirs.md');
		await git(
			other,
			'-c',
			'user.name=Other',
			'-c',
			'user.email=other@example.test',
			'commit',
			'--quiet',
			'-m',
			'Theirs',
		);
		await git(other, 'push', '--quiet', 'origin', 'main');
		const synced = await runHistory(root, { op: 'sync' }, { author });
		expect(expectOk(synced.result as never)).toMatchObject({ kind: 'synced' });
		expect(synced.landed).toEqual(['theirs.md']);
		expect(await readFile(join(root, 'theirs.md'), 'utf8')).toBe('theirs\n');
		expect(await readFile(join(root, 'kept.md'), 'utf8')).toBe('kept\n');

		// The sync staged beside the folder, privately, and left nothing.
		expect((await stat(staging)).mode & 0o777).toBe(0o700);
		expect(await readdir(staging)).toEqual([]);
		expect(await readdir(oldScratch)).toEqual([oldName]);
		expect(await readFile(join(oldScratch, oldName), 'utf8')).toBe(
			'older version',
		);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}, 60_000);
