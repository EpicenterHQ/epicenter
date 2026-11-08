import { afterEach, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedGit, git } from './git.ts';
import { fixture } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function repo() {
	const f = await fixture();
	roots.push(f.root);
	const folder = await f.app(
		'reading',
		`export default defineApp({name:'reading',description:'Reading',actions:{}});`,
	);
	const bare = join(f.root, 'remote.git');
	await mkdir(bare);
	await checkedGit(bare, 'init', '--bare', '-q');
	await checkedGit(folder, 'remote', 'add', 'origin', bare);
	await checkedGit(folder, 'push', '-q', '-u', 'origin', 'HEAD');
	const peer = join(f.root, 'peer');
	const clone = Bun.spawn(['git', 'clone', '-q', bare, peer], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stderr, code] = await Promise.all([
		new Response(clone.stderr).text(),
		clone.exited,
	]);
	if (code !== 0) throw new Error(stderr);
	await checkedGit(peer, 'config', 'user.name', 'Peer');
	await checkedGit(peer, 'config', 'user.email', 'peer@example.com');
	return { ...f, folder, bare, peer };
}

async function commit(folder: string, path: string, contents: string) {
	await writeFile(join(folder, path), contents);
	await checkedGit(folder, 'add', '--', path);
	await checkedGit(folder, 'commit', '-q', '-m', 'edit');
}

async function sync(f: Awaited<ReturnType<typeof repo>>) {
	const result = await f.run('sync', '--json');
	return {
		...result,
		rows: JSON.parse(result.stdout).apps as Array<Record<string, unknown>>,
	};
}

test('sync reports current, pulled, pushed, no remote, and uncommitted', async () => {
	const f = await repo();
	await f.app(
		'other',
		`export default defineApp({name:'other',description:'Other',actions:{}});`,
	);
	let result = await sync(f);
	expect(result.code).toBe(0);
	expect(result.rows.map((row) => [row.name, row.status])).toEqual([
		['other', 'no-remote'],
		['reading', 'current'],
	]);
	await commit(f.peer, 'peer.md', 'peer');
	await checkedGit(f.peer, 'push', '-q');
	result = await sync(f);
	expect(result.rows[1]).toMatchObject({ status: 'pulled', pulled: 1 });
	await commit(f.folder, 'local.md', 'local');
	result = await sync(f);
	expect(result.rows[1]).toMatchObject({ status: 'pushed', pushed: 1 });
	await writeFile(join(f.folder, 'scratch.md'), 'mine');
	result = await sync(f);
	expect(result.code).toBe(1);
	expect(result.rows[1]).toMatchObject({
		status: 'current',
		uncommitted: ['scratch.md'],
	});
});

test('sync leaves a real merge conflict and its markers', async () => {
	const f = await repo();
	await commit(f.folder, 'shared.md', 'base\n');
	await checkedGit(f.folder, 'push', '-q');
	await checkedGit(f.peer, 'pull', '-q');
	await commit(f.folder, 'shared.md', 'local\n');
	await commit(f.peer, 'shared.md', 'peer\n');
	await checkedGit(f.peer, 'push', '-q');
	const result = await sync(f);
	expect(result.code).toBe(1);
	expect(result.rows[0]).toMatchObject({
		status: 'conflict',
		conflicts: ['shared.md'],
	});
	expect(await readFile(join(f.folder, 'shared.md'), 'utf8')).toContain(
		'<<<<<<<',
	);
});

test('sync merges two append-only clones with merge=union', async () => {
	const f = await repo();
	await commit(f.folder, '.gitattributes', 'log.txt merge=union\n');
	await commit(f.folder, 'log.txt', 'base\n');
	await checkedGit(f.folder, 'push', '-q');
	await checkedGit(f.peer, 'pull', '-q');
	await commit(f.folder, 'log.txt', 'base\nlocal\n');
	await commit(f.peer, 'log.txt', 'base\npeer\n');
	await checkedGit(f.peer, 'push', '-q');
	const result = await sync(f);
	expect(result.code).toBe(0);
	expect(result.rows[0]?.status).toBe('pushed');
	const text = await readFile(join(f.folder, 'log.txt'), 'utf8');
	expect(text).toContain('local');
	expect(text).toContain('peer');
	expect((await git(f.peer, 'pull', '--no-rebase', '--no-edit')).code).toBe(0);
});

test('sync refuses an app nested in another repository', async () => {
	const f = await fixture();
	roots.push(f.root);
	const folder = await f.app(
		'reading',
		`export default defineApp({name:'reading',description:'Reading',actions:{}});`,
	);
	await rm(join(folder, '.git'), { recursive: true });
	await checkedGit(f.home, 'init', '-q');
	const result = await f.run('sync', '--json');
	expect(result.code).toBe(1);
	expect(JSON.parse(result.stdout).apps[0]).toMatchObject({
		status: 'failed',
		message: expect.stringContaining('must be the top level'),
	});
});
