/**
 * Acceptance, stage 3: the folder, offline (ADR-0851, ADR-0852, ADR-0854,
 * ADR-0856). Black-box runs of the real `epicenter` against a temporary HOME,
 * with bare repositories standing in for `origin` and for a shared app.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { lstat, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	declarationOf,
	fixture,
	gitIn,
	gitignore,
} from './runner.test-support.ts';

setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const f = await fixture();
	roots.push(f.root);
	return f;
}

const journalCode = `import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';
export default defineApp(declaration, {
	actions: {
		write: {
			description: 'Write a page',
			input: { page: field.text() },
			positional: ['page'],
			run: async ({ page }, { folder }) => {
				await folder.write(page + '.md', page);
			},
		},
		context: {
			description: 'Name what run receives, and keep an index in the cache',
			input: {},
			run: async (_, context) => {
				const { Database } = await import('bun:sqlite');
				await context.folder.write('.cache/seen.txt', 'cache');
				const db = new Database(context.folder.path + '/.cache/index.sqlite');
				db.run('CREATE TABLE IF NOT EXISTS pages (name TEXT)');
				db.close();
				return Object.keys(context).sort();
			},
		},
		picture: {
			description: 'Write a binary',
			input: {},
			run: async (_, { folder }) => {
				await folder.writeBytes('cover.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
			},
		},
	},
});
`;

const journal = {
	'.gitignore': gitignore,
	'.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n',
	'epicenter.json': declarationOf('journal'),
	'epicenter.ts': journalCode,
};

test('W1 the cache is .cache/ in the folder, and run receives { folder, secrets }', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'journal'), journal);
	const result = await f.run('journal', 'context', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		action: { returned: ['folder', 'secrets'] },
		refused: [],
		commit: null,
		paths: [],
		push: null,
	});
	expect(existsSync(join(folder, '.cache/index.sqlite'))).toBe(true);
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
	// Bun keeps its own transpiler cache under ~/Library/Caches/bun; epicenter keeps none there.
	expect(existsSync(join(f.root, 'Library/Caches/so.epicenter.apps'))).toBe(
		false,
	);
	expect((await f.run('--help')).stdout).not.toContain('EPICENTER_CACHE_HOME');
	expect(
		JSON.parse((await f.run('journal', '--json')).stdout),
	).not.toHaveProperty('cache');
});

test('W2 epicenter sync is gone', async () => {
	const f = await setup();
	const result = await f.run('sync', '--json');
	expect(result.code).toBe(2);
	expect(JSON.parse(result.stdout).error.message).toContain(
		'Unknown app "sync"',
	);
	expect((await f.run('--help')).stdout).not.toContain('sync');
});

test('W3 after a commit epicenter pushes fast-forward to origin when tracked, never pulls, and the listing reports ahead and behind', async () => {
	const f = await setup();
	const seed = await f.folder(join(f.root, 'seed'), journal);
	const bare = join(f.root, 'origin.git');
	await gitIn(f.root, 'clone', '-q', '--bare', seed, bare);
	const folder = join(f.home, 'journal');
	await gitIn(f.root, 'clone', '-q', bare, folder);
	const branch = await gitIn(folder, 'rev-parse', '--abbrev-ref', 'HEAD');

	const pushed = await f.run('journal', 'write', 'monday');
	expect(pushed.code).toBe(0);
	expect(pushed.stderr).toContain('pushed to origin');
	expect(await gitIn(bare, 'rev-parse', branch)).toBe(
		await gitIn(folder, 'rev-parse', 'HEAD'),
	);
	let listed = JSON.parse((await f.run('journal', '--json')).stdout);
	expect(listed.origin).toEqual({ ahead: 0, behind: 0 });

	const peer = join(f.root, 'peer');
	await gitIn(f.root, 'clone', '-q', bare, peer);
	await writeFile(join(peer, 'peer.md'), 'peer');
	await gitIn(peer, 'add', 'peer.md');
	await gitIn(
		peer,
		'-c',
		'user.name=Peer',
		'-c',
		'user.email=p@example.com',
		'commit',
		'-q',
		'-m',
		'peer',
	);
	await gitIn(peer, 'push', '-q');

	const local = await f.run('journal', 'write', 'tuesday');
	expect(local.code).toBe(0);
	expect(local.stderr).toContain('not pushed');
	expect(local.stderr).toContain('Run: git -C');
	expect(existsSync(join(folder, 'peer.md'))).toBe(false);
	expect(await gitIn(bare, 'log', '-1', '--format=%s', branch)).toBe('peer');
	listed = JSON.parse((await f.run('journal', '--json')).stdout);
	expect(listed.origin).toEqual({ ahead: 1, behind: 1 });
	expect((await f.run()).stdout).toContain('1 ahead and 1 behind origin');

	const worktree = join(f.root, 'worktree');
	await gitIn(folder, 'worktree', 'add', '-q', '-b', 'experiment', worktree);
	const before = await gitIn(bare, 'rev-parse', branch);
	const untracked = await f.run(worktree, 'write', 'draft');
	expect(untracked.code).toBe(0);
	expect(untracked.stderr).not.toContain('push');
	expect(await gitIn(bare, 'rev-parse', branch)).toBe(before);
	expect((await gitIn(bare, 'branch', '--list', 'experiment')).trim()).toBe('');
});

test('W4 epicenter new writes the template and runs git init', async () => {
	const f = await setup();
	const result = await f.run('new', 'garden', '--json');
	expect(result.code).toBe(0);
	const folder = join(f.home, 'garden');
	expect(JSON.parse(result.stdout)).toEqual({ name: 'garden', folder });
	expect(
		JSON.parse(await readFile(join(folder, 'epicenter.json'), 'utf8')),
	).toEqual({
		$schema: 'https://epicenter.so/epicenter.schema.json',
		name: 'garden',
		description: 'Describe garden',
	});
	expect(await readFile(join(folder, '.gitignore'), 'utf8')).toBe(gitignore);
	const attributes = await readFile(join(folder, '.gitattributes'), 'utf8');
	for (const kind of ['webm', 'm4a', 'png', 'jpg', 'heic', 'pdf', 'mov'])
		expect(attributes).toContain(
			`*.${kind} filter=lfs diff=lfs merge=lfs -text`,
		);
	expect(await gitIn(folder, 'log', '--format=%s')).toBe('new garden');
	expect(await gitIn(folder, 'status', '--porcelain')).toBe('');
	const listed = JSON.parse((await f.run('--json')).stdout);
	expect(listed.apps.map((app: { name: string }) => app.name)).toEqual([
		'garden',
	]);
});

test('W5 epicenter add links a folder, makes its history on request, and copies an app from a Git URL with an upstream branch', async () => {
	const f = await setup();
	const vault = await f.folder(
		join(f.root, 'Code', 'vault'),
		{ 'epicenter.json': declarationOf('vault'), 'notes/a.md': 'a\n' },
		{ git: false },
	);
	const refused = await f.run('add', vault, '--json');
	expect(refused.code).toBe(2);
	expect(JSON.parse(refused.stdout).error.next).toBe(
		`epicenter add ${vault} --init`,
	);
	expect(existsSync(join(f.home, 'vault'))).toBe(false);

	const added = await f.run('add', vault, '--init', '--json');
	expect(added.code).toBe(0);
	expect(JSON.parse(added.stdout)).toEqual({
		name: 'vault',
		folder: join(f.home, 'vault'),
	});
	expect((await lstat(join(f.home, 'vault'))).isSymbolicLink()).toBe(true);
	expect(await readlink(join(f.home, 'vault'))).toBe(vault);
	expect(await gitIn(vault, 'log', '--format=%s')).toBe('add vault');
	expect(await gitIn(vault, 'ls-files')).toBe('epicenter.json\nnotes/a.md');

	const source = await f.folder(join(f.root, 'shared', 'recipes'), {
		'.gitignore': gitignore,
		'epicenter.json': declarationOf('recipes'),
		'soup.md': 'soup\n',
	});
	const sha = await gitIn(source, 'rev-parse', 'HEAD');
	const url = `file://${source}`;
	const copied = await f.run('add', url, '--json');
	expect(copied.code).toBe(0);
	const folder = join(f.home, 'recipes');
	expect(JSON.parse(copied.stdout)).toEqual({ name: 'recipes', folder });
	expect(await readFile(join(folder, 'soup.md'), 'utf8')).toBe('soup\n');
	expect(await gitIn(folder, 'rev-parse', 'upstream')).toBe(sha);
	expect(await gitIn(folder, 'remote', 'get-url', 'upstream')).toBe(url);
	expect(await gitIn(folder, 'remote')).toBe('upstream');
	const branch = await gitIn(folder, 'rev-parse', '--abbrev-ref', 'HEAD');
	expect(branch).not.toBe('upstream');
	expect(
		(
			await gitIn(
				folder,
				'config',
				'--get-regexp',
				`^branch\\.${branch}\\.`,
			).catch(() => '')
		).trim(),
	).toBe('');

	const listed = JSON.parse((await f.run('--json')).stdout);
	expect(listed.apps.map((app: { name: string }) => app.name)).toEqual([
		'recipes',
		'vault',
	]);
});

test('W6 a write to a path marked for LFS is refused when git-lfs is not on PATH or its filter is not set up', async () => {
	const f = await setup();
	const folder = await f.folder(join(f.home, 'journal'), journal);
	const before = await gitIn(folder, 'rev-parse', 'HEAD');
	const env = { ...f.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
	const child = Bun.spawn(
		[process.execPath, f.bin, 'journal', 'picture', '--json'],
		{
			cwd: f.root,
			env,
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [stdout, code] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
	]);
	expect(code).toBe(3);
	expect(JSON.parse(stdout).refused).toMatchObject([
		{ path: 'cover.png', reason: 'lfs-not-installed' },
	]);
	expect(existsSync(join(folder, 'cover.png'))).toBe(false);
	expect(await gitIn(folder, 'rev-parse', 'HEAD')).toBe(before);

	const unset = await f.run('journal', 'picture', '--json');
	expect(unset.code).toBe(3);
	expect(JSON.parse(unset.stdout).refused).toMatchObject([
		{ reason: 'lfs-not-set-up', next: `git -C ${folder} lfs install --local` },
	]);

	if (!Bun.which('git-lfs')) return;
	await gitIn(folder, 'lfs', 'install', '--local');
	const stored = await f.run('journal', 'picture', '--json');
	expect(stored.code).toBe(0);
	expect(await gitIn(folder, 'show', 'HEAD:cover.png')).toStartWith(
		'version https://git-lfs.github.com/spec/v1',
	);
});
