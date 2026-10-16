/**
 * `status`, `history`, `save-version`, and `sync` through fresh CLI
 * processes, against a real bare remote, as the desktop shell runs them for a
 * page (ADR-0559).
 *
 * Key behaviors:
 * - A sync of competing changes merges them into one commit that this
 *   folder wins, binary files included, and asks nothing
 * - Two processes running save-version and sync at once take turns under the
 *   folder's history lock and leave one linear history the remote holds
 * - A save-version waits while another process holds the history lock
 * - Without a usable `git`, every history command exits 2 with `GitMissing`
 * - A sync runs only the `git` `locateGit` finds, never one from `PATH`
 *
 * They run `src/bin.ts` under Bun, or the compiled binary `EPICENTER_BIN`
 * names.
 */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
	type HistoryReply,
	type HistoryResults,
	holdingHistoryLock,
} from '@epicenter/folder/bun';

const binary = process.env.EPICENTER_BIN;
const command = binary
	? [resolve(binary)]
	: [process.execPath, '--no-install', resolve(import.meta.dir, 'bin.ts')];

const ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Remote',
	GIT_AUTHOR_EMAIL: 'remote@example.test',
	GIT_COMMITTER_NAME: 'Remote',
	GIT_COMMITTER_EMAIL: 'remote@example.test',
};

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: ENV,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
	return stdout.trim();
}

/** Run the CLI; `input` goes to its standard input. */
async function epicenter(
	args: string[],
	{ input, env = {} }: { input?: string; env?: Record<string, string> } = {},
) {
	const child = Bun.spawn([...command, ...args], {
		env: { ...ENV, ...env },
		stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

/** Run a history command with `--json` and read its one reply line. */
async function reply<K extends keyof HistoryResults>(
	_kind: K,
	args: string[],
	options?: Parameters<typeof epicenter>[1],
) {
	const ran = await epicenter([...args, '--json'], options);
	const lines = ran.stdout.trim().split('\n');
	expect(lines).toHaveLength(1);
	return {
		...ran,
		reply: JSON.parse(lines[0]!) as HistoryReply<HistoryResults[K]>,
	};
}

const DECLARATION = JSON.stringify({
	tables: {
		posts: {
			type: 'object',
			properties: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
	},
});

async function write(root: string, path: string, content: string | Uint8Array) {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), content);
}

/**
 * A folder synced once to a bare remote, and a plain clone of that remote
 * where "another device" commits.
 */
async function synced(files: Record<string, string | Uint8Array>) {
	const project = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-history-')),
	);
	temporary.push(project);
	const bare = join(project, 'remote.git');
	await git(
		project,
		'init',
		'--quiet',
		'--bare',
		'--initial-branch=main',
		bare,
	);
	const folder = join(project, 'folder');
	await mkdir(folder);
	for (const [path, content] of Object.entries(files))
		await write(folder, path, content);
	// The person connected the folder with their own Git.
	await git(folder, 'init', '--quiet', '--initial-branch=main');
	await git(folder, 'config', 'remote.origin.url', bare);
	const first = await reply('sync', ['sync', folder]);
	expect(first.exitCode).toBe(0);
	expect(first.reply.result.data?.kind).toBe('synced');
	const other = join(project, 'other');
	await git(project, 'clone', '--quiet', bare, other);
	return { project, bare, folder, other };
}

const bytes = (...values: number[]) => new Uint8Array(values);

test('status, save-version, and history read and record the folder', async () => {
	const { folder } = await synced({ 'notes/a.md': 'a\n' });
	const clean = await reply('status', ['status', folder]);
	expect(clean.exitCode).toBe(0);
	expect(clean.reply.result.data?.changes).toEqual([]);
	expect(clean.reply.state.sync).toMatchObject({ ahead: 0, behind: 0 });

	await write(folder, 'notes/b.md', 'b\n');
	const changed = await reply('status', ['status', folder]);
	expect(changed.reply.result.data?.changes).toEqual([
		{ kind: 'add', path: 'notes/b.md' },
	]);

	const saved = await reply('saveVersion', [
		'save-version',
		folder,
		'-m',
		'Add b',
	]);
	expect(saved.exitCode).toBe(0);
	expect(saved.reply.result).toMatchObject({
		status: 'committed',
		message: 'Add b',
	});
	expect(await git(folder, 'log', '-1', '--format=%an <%ae> %s')).toBe(
		'Epicenter <epicenter@localhost> Add b',
	);
	const again = await reply('saveVersion', ['save-version', folder]);
	expect(again.reply.result.status).toBe('unchanged');

	const log = await reply('log', ['history', folder, '--depth', '5']);
	expect(log.reply.result.data?.map((commit) => commit.message.trim())).toEqual(
		['Add b', 'Add notes/a.md'],
	);
	const after = await reply('status', ['status', folder]);
	expect(after.reply.state.sync).toMatchObject({ ahead: 1, behind: 0 });
});

test('a sync of competing changes merges them into one commit this folder wins, asking nothing', async () => {
	const { folder, other } = await synced({
		'epicenter.json': DECLARATION,
		'posts/x.md': '---\ntitle: Base\ndone: false\n---\n',
		'notes.txt': 'one\ntwo\nthree\n',
		'doc.md': 'kept\n',
		'image.bin': bytes(0, 1, 2),
	});
	// Another device changes each, and pushes.
	await write(other, 'posts/x.md', '---\ntitle: Theirs\ndone: false\n---\n');
	await write(other, 'notes.txt', 'one\nTWO (theirs)\nthree\n');
	await rm(join(other, 'doc.md'));
	await write(other, 'image.bin', bytes(0, 1, 3));
	await git(other, 'add', '--all');
	await git(other, 'commit', '--quiet', '-m', 'Theirs');
	await git(other, 'push', '--quiet', 'origin', 'main');
	const theirs = await git(other, 'rev-parse', 'HEAD');
	// This folder changes the same units, unsaved.
	await write(folder, 'posts/x.md', '---\ntitle: Mine\ndone: true\n---\n');
	await write(folder, 'notes.txt', 'one\ntwo (mine)\nthree\n');
	await write(folder, 'doc.md', 'changed here\n');
	await write(folder, 'image.bin', bytes(0, 1, 4));

	const result = await reply('sync', ['sync', folder]);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.reply.result.data?.kind).toBe('synced');
	expect(await readFile(join(folder, 'posts/x.md'), 'utf8')).toBe(
		'---\ntitle: Mine\ndone: true\n---\n',
	);
	expect(await readFile(join(folder, 'notes.txt'), 'utf8')).toBe(
		'one\ntwo (mine)\nthree\n',
	);
	// A delete beats an edit it never saw.
	expect(existsSync(join(folder, 'doc.md'))).toBe(false);
	expect(new Uint8Array(await readFile(join(folder, 'image.bin')))).toEqual(
		bytes(0, 1, 4),
	);
	// One merge of both heads, which the remote holds, naming what lost.
	const head = await git(folder, 'rev-parse', 'HEAD');
	const parents = (await git(folder, 'log', '-1', '--format=%P')).split(' ');
	expect(parents).toHaveLength(2);
	expect(parents[1]).toBe(theirs);
	const message = await git(folder, 'log', '-1', '--format=%B');
	expect(message).toContain(`Overrode: ${theirs} field="title" "posts/x.md"`);
	expect(message).toContain(`Overrode: ${theirs} file "image.bin"`);
	expect(message).toContain(`Overrode: ${parents[0]} file "doc.md"`);
	expect(await git(other, 'ls-remote', 'origin', 'main')).toStartWith(head);
	expect(await git(folder, 'status', '--porcelain')).toBe('');
});

test('save-version and sync from two processes at once take turns and leave one linear history', async () => {
	const { folder, other } = await synced({ 'a.md': 'a\n' });
	for (let round = 0; round < 3; round++) {
		await git(other, 'pull', '--quiet', '--rebase', 'origin', 'main');
		await write(other, `remote-${round}.md`, `${round}\n`);
		await git(other, 'add', '--all');
		await git(other, 'commit', '--quiet', '-m', `Remote ${round}`);
		await git(other, 'push', '--quiet', 'origin', 'main');
		await write(folder, `local-${round}.md`, `${round}\n`);
		const [saved, syncedRun] = await Promise.all([
			reply('saveVersion', ['save-version', folder, '-m', `Local ${round}`]),
			reply('sync', ['sync', folder]),
		]);
		expect(saved.exitCode, saved.stderr).toBe(0);
		expect(['committed', 'unchanged']).toContain(saved.reply.result.status);
		expect(syncedRun.exitCode, syncedRun.stderr).toBe(0);
		expect(syncedRun.reply.result.error).toBeNull();
	}
	// One more sync sends whatever a save-version recorded after the last sync.
	expect((await reply('sync', ['sync', folder])).reply.result.data?.kind).toBe(
		'synced',
	);
	await git(folder, 'fsck', '--strict');
	expect(await git(folder, 'status', '--porcelain')).toBe('');
	const head = await git(folder, 'rev-parse', 'HEAD');
	await git(other, 'fetch', '--quiet', 'origin');
	expect(await git(other, 'rev-parse', 'origin/main')).toBe(head);
	for (let round = 0; round < 3; round++) {
		expect(existsSync(join(folder, `remote-${round}.md`))).toBe(true);
		expect(
			await git(folder, 'ls-tree', '--name-only', head, `local-${round}.md`),
		).toBe(`local-${round}.md`);
	}
});

test('a save-version waits while another process holds the history lock', async () => {
	const { folder } = await synced({ 'a.md': 'a\n' });
	await write(folder, 'b.md', 'b\n');
	let released = 0;
	let finished = 0;
	const saving = Promise.withResolvers<Awaited<ReturnType<typeof epicenter>>>();
	await holdingHistoryLock(folder, async () => {
		void epicenter(['save-version', folder, '--json']).then((ran) => {
			finished = Date.now();
			saving.resolve(ran);
		});
		await Bun.sleep(1500);
		released = Date.now();
	});
	const ran = await saving.promise;
	expect(ran.exitCode, ran.stderr).toBe(0);
	expect(finished).toBeGreaterThanOrEqual(released);
	expect(
		existsSync(join(dirname(folder), '.folder.epicenter-history-lock')),
	).toBe(true);
});

test('without a usable git, every history command exits 2 with GitMissing', async () => {
	const folder = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-nogit-')),
	);
	temporary.push(folder);
	for (const args of [
		['status', folder],
		['history', folder],
		['save-version', folder],
		['sync', folder],
	]) {
		const ran = await epicenter([...args, '--json'], {
			env: { EPICENTER_GIT: join(folder, 'no-such-git') },
		});
		expect(ran.exitCode).toBe(2);
		expect(JSON.parse(ran.stdout)).toMatchObject({
			error: 'GitMissing',
			install:
				process.platform === 'darwin'
					? 'command-line-tools'
					: process.platform === 'win32'
						? 'git-for-windows'
						: 'package-manager',
		});
	}
});

test('a sync of a connected folder runs no git from PATH: only the one locateGit finds', async () => {
	const { project, folder } = await synced({ 'notes/a.md': 'a\n' });
	await write(folder, 'notes/a.md', 'b\n');
	// Stands in for `/usr/bin/git` on a Mac without the Command Line Tools:
	// the xcrun shim, which shows the install dialog and exits 1. It heads
	// a Finder launch's `PATH`, so any `git` started by name reaches it.
	const shims = join(project, 'shims');
	await mkdir(shims);
	const calls = join(shims, 'calls');
	await writeFile(calls, '');
	await writeFile(
		join(shims, 'git'),
		`#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 1\n`,
	);
	chmodSync(join(shims, 'git'), 0o755);
	const env: Record<string, string | undefined> = {
		...ENV,
		PATH: `${shims}:/usr/bin:/bin`,
	};
	delete env.EPICENTER_GIT;
	const child = Bun.spawn([...command, 'sync', folder, '--json'], {
		env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, `${stdout}${stderr}`).toBe(0);
	// `locateGit` may ask a `git` on `PATH` for its version, and passes over
	// one that fails; nothing else runs one by name.
	const ran = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
	expect(ran.filter((call) => call !== '--version')).toEqual([]);
});
