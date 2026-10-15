/**
 * `epicenter merge-driver` under real `git merge`: a repository configured
 * by `epicenter merge-driver <dir>`, two branches, and Git running the CLI
 * as its merge driver (ADR-0566).
 *
 * Key behaviors:
 * - Configuring writes `* merge=epicenter` to `.git/info/attributes` and the
 *   driver to `.git/config`, once however often it runs, and nothing tracked
 * - Different fields of one row, and `kv.json` keys, merge; one field both
 *   sides changed is a conflict Git reports, with markers and stages
 * - Plain text merges by line, neighboring lines included
 * - A binary file and a file in no data folder merge as Git's default does
 * - A driver path that points nowhere is an ordinary conflict, not an abort
 * - Epicenter's own sync, which never runs `git merge`, is unaffected
 *
 * They run `src/bin.ts` under Bun, or the compiled binary `EPICENTER_BIN`
 * names.
 */
import { afterEach, expect, test } from 'bun:test';
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

const binary = process.env.EPICENTER_BIN;
const command = binary
	? [resolve(binary)]
	: [process.execPath, '--no-install', resolve(import.meta.dir, 'bin.ts')];

const ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.test',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.test',
	EPICENTER_AUTHOR_NAME: 'Desktop',
	EPICENTER_AUTHOR_EMAIL: 'desktop@example.test',
};

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function run(cmd: string[], cwd: string) {
	const child = Bun.spawn(cmd, {
		cwd,
		env: ENV,
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

async function git(cwd: string, ...args: string[]) {
	const ran = await run(['git', ...args], cwd);
	if (ran.exitCode !== 0)
		throw new Error(`git ${args.join(' ')}: ${ran.stderr}`);
	return ran.stdout.trim();
}

const epicenter = (cwd: string, ...args: string[]) =>
	run([...command, ...args], cwd);

async function write(root: string, path: string, content: string | Uint8Array) {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), content);
}

const DECLARATION = JSON.stringify({
	kv: {
		type: 'object',
		properties: {
			a: { type: 'number' },
			b: { type: 'number' },
			c: { type: 'number' },
		},
	},
	tables: {
		posts: {
			type: 'object',
			properties: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
	},
});

const row = (title: string, done: boolean) =>
	`---\ntitle: ${title}\ndone: ${done}\n---\nbody\n`;

/** A repository at `<dir>/repo` with `files` committed on `main`, configured by the CLI. */
async function repository(files: Record<string, string | Uint8Array>) {
	const dir = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-merge-driver-')),
	);
	temporary.push(dir);
	const repo = join(dir, 'repo');
	await mkdir(repo);
	await git(repo, 'init', '--quiet', '--initial-branch=main');
	for (const [path, content] of Object.entries(files))
		await write(repo, path, content);
	await git(repo, 'add', '--all');
	await git(repo, 'commit', '--quiet', '-m', 'Base');
	const configured = await epicenter(repo, 'merge-driver', repo);
	expect(configured.exitCode).toBe(0);
	return { dir, repo };
}

/**
 * `theirs` committed on a branch, `ours` on `main`, then `git merge` of the
 * branch into `main`.
 */
async function mergeBranches(
	repo: string,
	ours: Record<string, string | Uint8Array>,
	theirs: Record<string, string | Uint8Array>,
) {
	await git(repo, 'checkout', '--quiet', '-b', 'theirs');
	for (const [path, content] of Object.entries(theirs))
		await write(repo, path, content);
	await git(repo, 'commit', '--quiet', '--all', '-m', 'Theirs');
	await git(repo, 'checkout', '--quiet', 'main');
	for (const [path, content] of Object.entries(ours))
		await write(repo, path, content);
	await git(repo, 'commit', '--quiet', '--all', '-m', 'Ours');
	return run(['git', 'merge', '--no-edit', 'theirs'], repo);
}

const read = (repo: string, path: string) => readFile(join(repo, path), 'utf8');
const unmerged = (repo: string) =>
	git(repo, 'diff', '--name-only', '--diff-filter=U');

test('configuring writes the attribute and the driver once, and nothing tracked', async () => {
	const { repo } = await repository({ 'epicenter.json': DECLARATION });
	expect((await epicenter(repo, 'merge-driver', repo)).exitCode).toBe(0);
	expect(await read(repo, '.git/info/attributes')).toBe('* merge=epicenter\n');
	expect(await git(repo, 'config', '--get', 'merge.epicenter.name')).toBe(
		'Epicenter folder merge',
	);
	expect(
		await git(repo, 'config', '--get', 'merge.epicenter.driver'),
	).toEndWith(' merge-driver -- %O %A %B %P');
	expect(await git(repo, 'status', '--porcelain')).toBe('');
	expect(await git(repo, 'check-attr', 'merge', '--', 'posts/x.md')).toBe(
		'posts/x.md: merge: epicenter',
	);
});

test('a folder with no repository of its own is refused', async () => {
	const dir = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-merge-driver-')),
	);
	temporary.push(dir);
	const configured = await epicenter(dir, 'merge-driver', dir);
	expect(configured.exitCode).toBe(2);
	expect(configured.stderr).toContain('has no repository yet');
});

test('different fields of one row merge by field', async () => {
	const { repo } = await repository({
		'epicenter.json': DECLARATION,
		'posts/x.md': row('Base', false),
	});
	const merged = await mergeBranches(
		repo,
		{ 'posts/x.md': row('Base', true) },
		{ 'posts/x.md': row('Theirs', false) },
	);
	expect(merged.exitCode).toBe(0);
	expect(await read(repo, 'posts/x.md')).toBe(row('Theirs', true));
});

test('the same field both sides changed is a conflict Git reports', async () => {
	const { repo } = await repository({
		'epicenter.json': DECLARATION,
		'posts/x.md': row('Base', false),
	});
	const merged = await mergeBranches(
		repo,
		{ 'posts/x.md': row('Mine', true) },
		{ 'posts/x.md': row('Theirs', false) },
	);
	expect(merged.exitCode).toBe(1);
	expect(merged.stdout).toContain(
		'CONFLICT (content): Merge conflict in posts/x.md',
	);
	expect(await unmerged(repo)).toBe('posts/x.md');
	expect(await read(repo, 'posts/x.md')).toBe(
		'---\n<<<<<<< ours\ntitle: Mine\n=======\ntitle: Theirs\n>>>>>>> theirs\ndone: true\n---\nbody\n',
	);
	// The stages hold each side as committed, for Sync's review to read.
	expect(await git(repo, 'show', ':2:posts/x.md')).toBe(
		row('Mine', true).trim(),
	);
	expect(await git(repo, 'show', ':3:posts/x.md')).toBe(
		row('Theirs', false).trim(),
	);
});

test('kv.json keys both sides added combine', async () => {
	const { repo } = await repository({
		'epicenter.json': DECLARATION,
		'kv.json': '{\n  "a": 1\n}\n',
	});
	const merged = await mergeBranches(
		repo,
		{ 'kv.json': '{\n  "a": 1,\n  "b": 2\n}\n' },
		{ 'kv.json': '{\n  "a": 1,\n  "c": 3\n}\n' },
	);
	expect(merged.exitCode).toBe(0);
	expect(JSON.parse(await read(repo, 'kv.json'))).toEqual({ a: 1, b: 2, c: 3 });
});

test('a plain text file merges by line, neighboring lines included', async () => {
	const { repo } = await repository({
		'epicenter.json': DECLARATION,
		'notes.txt': 'one\ntwo\nthree\n',
	});
	const merged = await mergeBranches(
		repo,
		{ 'notes.txt': 'ONE\ntwo\nthree\n' },
		{ 'notes.txt': 'one\nTWO\nthree\n' },
	);
	expect(merged.exitCode).toBe(0);
	expect(await read(repo, 'notes.txt')).toBe('ONE\nTWO\nthree\n');
});

test('a binary file keeps ours as a conflict, as Git does', async () => {
	const { repo } = await repository({
		'epicenter.json': DECLARATION,
		'image.bin': new Uint8Array([0, 1, 2]),
	});
	const merged = await mergeBranches(
		repo,
		{ 'image.bin': new Uint8Array([0, 1, 4]) },
		{ 'image.bin': new Uint8Array([0, 1, 3]) },
	);
	expect(merged.exitCode).toBe(1);
	expect(await unmerged(repo)).toBe('image.bin');
	expect([...(await readFile(join(repo, 'image.bin')))]).toEqual([0, 1, 4]);
});

test('a file in no data folder merges as Git merges text', async () => {
	const { repo } = await repository({
		'vault/epicenter.json': DECLARATION,
		'vault/posts/x.md': row('Base', false),
		'readme.txt': 'one\ntwo\nthree\n',
	});
	const merged = await mergeBranches(
		repo,
		{
			'readme.txt': 'ONE\ntwo\nthree\n',
			'vault/posts/x.md': row('Base', true),
		},
		{
			'readme.txt': 'one\nTWO\nthree\n',
			'vault/posts/x.md': row('Theirs', false),
		},
	);
	// Git's text merge has neighboring lines compete; the row in the nested
	// data folder still merges by field.
	expect(merged.exitCode).toBe(1);
	expect(await unmerged(repo)).toBe('readme.txt');
	expect(await read(repo, 'readme.txt')).toBe(
		'<<<<<<< ours\nONE\ntwo\n=======\none\nTWO\n>>>>>>> theirs\nthree\n',
	);
	expect(await read(repo, 'vault/posts/x.md')).toBe(row('Theirs', true));
});

test('a driver that points nowhere is an ordinary conflict, not an abort', async () => {
	const { repo } = await repository({
		'epicenter.json': DECLARATION,
		'posts/x.md': row('Base', false),
	});
	await git(
		repo,
		'config',
		'merge.epicenter.driver',
		"'/nowhere/epicenter' merge-driver -- %O %A %B %P",
	);
	const merged = await mergeBranches(
		repo,
		{ 'posts/x.md': row('Base', true) },
		{ 'posts/x.md': row('Theirs', false) },
	);
	expect(merged.exitCode).toBe(1);
	expect(await unmerged(repo)).toBe('posts/x.md');
	// Git keeps ours and records the stages.
	expect(await read(repo, 'posts/x.md')).toBe(row('Base', true));
	expect(await git(repo, 'ls-files', '--unmerged')).toContain('\t');
});

test("Epicenter's own sync merges as before with the driver configured", async () => {
	const { dir, repo } = await repository({
		'epicenter.json': DECLARATION,
		'posts/x.md': row('Base', false),
	});
	const bare = join(dir, 'remote.git');
	await git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
	await git(repo, 'remote', 'add', 'origin', bare);
	await git(repo, 'push', '--quiet', 'origin', 'main');
	const other = join(dir, 'other');
	await git(dir, 'clone', '--quiet', bare, other);
	await write(other, 'posts/x.md', row('Theirs', false));
	await git(other, 'commit', '--quiet', '--all', '-m', 'Theirs');
	await git(other, 'push', '--quiet', 'origin', 'main');
	await write(repo, 'posts/x.md', row('Base', true));

	const synced = await epicenter(repo, 'sync', repo);
	expect(synced.exitCode).toBe(0);
	expect(await read(repo, 'posts/x.md')).toBe(row('Theirs', true));
	expect(await git(repo, 'status', '--porcelain')).toBe('');
});

test('a sync that connects a remote configures the driver', async () => {
	const dir = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-merge-driver-')),
	);
	temporary.push(dir);
	await write(dir, 'epicenter.json', DECLARATION);
	await git(dir, 'init', '--quiet', '--initial-branch=main');
	// Nothing listens there; the connect is made whether or not the push lands.
	await epicenter(dir, 'sync', dir, '--remote', 'http://127.0.0.1:9/x.git');
	expect(await read(dir, '.git/info/attributes')).toBe('* merge=epicenter\n');
	expect(await git(dir, 'config', '--get', 'merge.epicenter.driver')).toEndWith(
		' merge-driver -- %O %A %B %P',
	);
});
