/**
 * Bun Save Lock Tests
 *
 * `@epicenter/folder/bun` takes the directory's save lock, an exclusive SQLite
 * transaction on `.<name>.epicenter-save-lock` beside it, around each check
 * and rename, as the desktop shell does (ADR-0562). Saves from separate
 * processes take turns, so none is lost.
 *
 * Key behaviors:
 * - A save waits while another process holds the save lock, then checks
 *   against what that process saved: `Conflict`, and the other save is kept
 * - Two processes saving one file over and over, each retrying on
 *   `Conflict`, lose no update
 *
 * See also:
 * - `registry_tests.rs` in `tauri-plugin-epicenter-folder`, where a shell
 *   save waits for a Bun process holding the same lock
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { openDataFolder } from './bun.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';

const author = { name: 'Saver', email: 'saver@localhost' };

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

test('a write waits for another process holding the save lock, then merges with its save', async () => {
	const root = await scratch('bun-save-lock-');
	const lock = join(dirname(root), `.${basename(root)}.epicenter-save-lock`);
	const target = join(root, 'note.txt');
	try {
		await writeFile(target, 'old');
		const folder = expectOk(await openDataFolder({ root, git: { author } }));

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
		const saving = folder.write('note.txt', 'old', 'ours').finally(() => {
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
		const written = expectOk(await saving);
		expect(written.overridden).not.toEqual([]);
		expect(await readFile(target, 'utf8')).toBe('ours');
		await folder.close();
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(lock, { force: true });
	}
});

test('two processes appending to one file through the one write keep every line once', async () => {
	const ROUNDS = 30;
	const root = await scratch('bun-write-race-');
	try {
		await writeFile(join(root, 'log.txt'), '');
		// Each process appends its own lines through \`folder.write\`: read the
		// file, then write the change from what it read to that plus a line.
		// A put the other process overtook merges again, keeping both lines;
		// one overtaken on every attempt is \`KeptChanging\`, landed nothing,
		// and is sent again.
		const appender = (id: number) =>
			Bun.spawn(
				[
					'bun',
					'-e',
					`
					const { openDataFolder } = await import(${JSON.stringify(join(import.meta.dir, 'bun.ts'))});
					const [root, rounds] = process.argv.slice(-2);
					const { data: folder, error } = await openDataFolder({
						root,
						git: { author: { name: 'Appender', email: 'appender@localhost' } },
					});
					if (error !== null) throw new Error(JSON.stringify(error));
					for (let line = 0; line < Number(rounds); ) {
						const read = await folder.files.read('log.txt');
						if (read.error !== null) throw new Error(JSON.stringify(read.error));
						const text = new TextDecoder().decode(read.data.bytes);
						const { error } = await folder.write('log.txt', text, text + 'p${id}-' + line + '\\n');
						if (error === null) line++;
						else if (error.name !== 'KeptChanging') throw new Error(JSON.stringify(error));
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
		await rm(join(dirname(root), `.${basename(root)}.epicenter-save-lock`), {
			force: true,
		});
	}
}, 60_000);

test('two processes saving one file, each retrying on Conflict, lose no update', async () => {
	const ROUNDS = 40;
	const root = await scratch('bun-save-race-');
	try {
		await writeFile(join(root, 'count.txt'), '0');
		// Each process counts up through `@epicenter/folder/bun` itself: read,
		// add one, save over what it read, and read again on `Conflict`.
		const counter = (id: number) =>
			Bun.spawn(
				[
					'bun',
					'-e',
					`
					const { openDataFolder } = await import(${JSON.stringify(join(import.meta.dir, 'bun.ts'))});
					const [root, rounds] = process.argv.slice(-2);
					const { data: folder, error } = await openDataFolder({
						root,
						git: { author: { name: 'Counter', email: 'counter@localhost' } },
					});
					if (error !== null) throw new Error(JSON.stringify(error));
					let conflicts = 0;
					for (let saved = 0; saved < Number(rounds); ) {
						const read = await folder.files.read('count.txt');
						if (read.error !== null) throw new Error(JSON.stringify(read.error));
						const count = Number(new TextDecoder().decode(read.data.bytes));
						const { error } = await folder.files.save(read.data, String(count + 1), { merge: false });
						if (error === null) saved++;
						else if (error.name === 'Conflict') conflicts++;
						else throw new Error(JSON.stringify(error));
					}
					await folder.close();
					console.log(JSON.stringify({ id: ${id}, conflicts }));
					`,
					'--',
					root,
					String(ROUNDS),
				],
				{ stdout: 'pipe', stderr: 'inherit', env: process.env },
			);
		const counters = [counter(0), counter(1)];
		const codes = await Promise.all(counters.map((child) => child.exited));
		expect(codes).toEqual([0, 0]);
		const reports = await Promise.all(
			counters.map((child) => new Response(child.stdout).json()),
		);
		expect(reports.map((report) => report.id)).toEqual([0, 1]);
		expect(await readFile(join(root, 'count.txt'), 'utf8')).toBe(
			String(2 * ROUNDS),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(join(dirname(root), `.${basename(root)}.epicenter-save-lock`), {
			force: true,
		});
	}
}, 60_000);
