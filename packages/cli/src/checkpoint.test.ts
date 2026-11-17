/** Root checkpoints preserve code and records together and keep ignored files out while refusing secrets and embedded repositories. */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpoint, snapshot } from './checkpoint.js';
import { hold } from './lock.js';
import { fixture, gitIn, reading } from './runner.test-support.js';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
async function setup() {
	const f = await fixture();
	roots.push(f.root);
	await gitIn(f.home, 'init', '-q');
	await writeFile(
		join(f.home, '.gitignore'),
		'/apps/*/local/\n*.local\n*.local.*\nnode_modules/\n/apps/*/code/ui/dist/\n/apps/*/.code-build-*/\n',
	);
	await checkpoint(f.home);
	return f;
}
const head = (dir: string) => gitIn(dir, 'rev-parse', 'HEAD');

test('checkpoint saves an invalid serving port while serve refuses it before listening', async () => {
	const f = await setup();
	const marker = '---\nport: 70000\n---\n';
	await writeFile(join(f.home, 'EPICENTER.md'), marker);
	await writeFile(join(f.home, 'note.md'), 'Keep this note.');
	const saved = await f.run('checkpoint', '--json');
	expect(saved.code).toBe(0);
	expect(JSON.parse(saved.stdout).committed.files).toBe(2);
	expect(await gitIn(f.home, 'show', 'HEAD:EPICENTER.md')).toBe(marker.trim());
	expect(await gitIn(f.home, 'show', 'HEAD:note.md')).toBe('Keep this note.');
	const before = await head(f.home);
	const refused = await f.run('serve');
	expect(refused.code).toBe(2);
	expect(refused.stderr).toContain('port: 70000');
	expect(refused.stderr).not.toContain('Serving');
	expect(await head(f.home)).toBe(before);
});

test('checkpoint requires a marker and suggests initializing the selected folder', async () => {
	const f = await setup();
	await rm(join(f.home, 'EPICENTER.md'));
	const refused = await f.run('checkpoint', '--json');
	expect(refused.code).toBe(2);
	expect(JSON.parse(refused.stdout).error.next).toBe(
		`epicenter init ${f.home}`,
	);
});

test('actions leave HEAD unchanged and checkpoint commits pending code and data with the requested subject', async () => {
	const f = await setup();
	const app = await f.app('x', reading);
	// Serve checkpoints once as it starts. Wait for that commit, so the only
	// later one is this test's.
	await f.serve();
	while ((await gitIn(f.home, 'status', '--porcelain')) !== '')
		await Bun.sleep(20);
	const before = await head(f.home);
	expect((await f.run('x', 'log', '{"minutes":30}')).code).toBe(0);
	expect(await head(f.home)).toBe(before);
	await writeFile(join(app, 'code/extra.ts'), 'export const value = 1;');
	const result = await f.run('checkpoint', '-m', 'before repair', '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).committed.files).toBe(2);
	expect(await gitIn(f.home, 'log', '-1', '--format=%s')).toBe('before repair');
	expect(await gitIn(f.home, 'show', '--format=', '--name-only', 'HEAD')).toBe(
		'apps/x/code/extra.ts\napps/x/data/records/log.json',
	);
	expect((await checkpoint(f.home)).committed).toBeNull();
});

test('unignored local files are refused and tracked local files name git rm --cached', async () => {
	const f = await setup();
	await writeFile(join(f.home, '.gitignore'), '');
	await writeFile(join(f.home, 'token.local'), 'secret');
	expect((await checkpoint(f.home)).failed?.message).toContain(
		'token.local would be committed',
	);
	expect(await gitIn(f.home, 'diff', '--cached', '--name-only')).toBe('');
	await gitIn(f.home, 'add', 'token.local');
	await gitIn(f.home, 'commit', '-qm', 'fixture secret');
	await writeFile(join(f.home, '.gitignore'), '*.local\n');
	expect((await checkpoint(f.home)).failed?.next).toBe(
		`git -C ${f.home} rm --cached -- token.local`,
	);
	await gitIn(f.home, 'rm', '--cached', 'token.local');
	expect((await checkpoint(f.home)).failed).toBeUndefined();
	expect(await readFile(join(f.home, 'token.local'), 'utf8')).toBe('secret');
});

test("a file in an app's local/ is refused until .gitignore keeps it out, and an old-named file under data/ still is", async () => {
	const f = await setup();
	await writeFile(join(f.home, '.gitignore'), '');
	await f.folder(join(f.apps, 'x'), { 'local/google.md': 'secret' });
	expect((await checkpoint(f.home)).failed?.message).toBe(
		`apps/x/local/google.md would be committed; add /apps/*/local/ to ${f.home}/.gitignore`,
	);
	await writeFile(join(f.home, '.gitignore'), '/apps/*/local/\n');
	await f.folder(join(f.apps, 'x'), { 'data/token.local.md': 'secret' });
	expect((await checkpoint(f.home)).failed?.message).toBe(
		`apps/x/data/token.local.md would be committed; add *.local and *.local.* to ${f.home}/.gitignore`,
	);
	expect(await gitIn(f.home, 'ls-files', '--', 'apps')).toBe('');
});

test('missing and broken code never prevent data checkpoints', async () => {
	const f = await setup();
	await f.folder(join(f.apps, 'missing'), { 'data/a.md': 'missing code' });
	await f.app('broken', 'throw new Error("broken");');
	await f.folder(join(f.apps, 'broken'), { 'data/b.md': 'broken code' });
	const result = await checkpoint(f.home);
	expect(result.failed).toBeUndefined();
	expect(await gitIn(f.home, 'show', 'HEAD:apps/missing/data/a.md')).toBe(
		'missing code',
	);
	expect(await gitIn(f.home, 'show', 'HEAD:apps/broken/data/b.md')).toBe(
		'broken code',
	);
});

test('an embedded data repository and a staged gitlink are refused', async () => {
	const f = await setup();
	const app = await f.app('x', reading);
	await mkdir(join(app, 'data'));
	await writeFile(join(app, 'data/a'), 'record');
	await checkpoint(f.home);
	const before = await head(f.home);
	await gitIn(join(app, 'data'), 'init', '-q');
	expect((await checkpoint(f.home)).failed?.message).toContain(
		'apps/x/data/ is a Git repository inside',
	);
	expect(await head(f.home)).toBe(before);
	await rm(join(app, 'data/.git'), { recursive: true });
	await f.folder(join(f.home, 'nested'), { note: 'note' }, { git: true });
	expect((await checkpoint(f.home)).failed?.message).toContain(
		'nested/ is a Git repository inside',
	);
	await gitIn(f.home, 'add', 'nested');
	expect((await checkpoint(f.home)).failed?.next).toBe(
		`git -C ${f.home} rm --cached -- nested`,
	);
});

test('an active merge and a held Git index defer without advancing HEAD', async () => {
	const f = await setup();
	const before = await head(f.home);
	await writeFile(join(f.home, '.git/MERGE_HEAD'), before + '\n');
	expect((await checkpoint(f.home)).deferred?.message).toContain('merge');
	await rm(join(f.home, '.git/MERGE_HEAD'));
	await writeFile(join(f.home, 'pending'), 'edit');
	await writeFile(join(f.home, '.git/index.lock'), 'held');
	expect((await checkpoint(f.home)).deferred?.message).toContain('index lock');
	expect(await head(f.home)).toBe(before);
	await rm(join(f.home, '.git/index.lock'));
	expect((await checkpoint(f.home)).committed?.files).toBe(1);
});

test('checkpoint pushes a local origin, retries an outstanding push, and preserves a divergent remote', async () => {
	const f = await setup();
	const remote = join(f.root, 'origin.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(f.home, 'remote', 'add', 'origin', join(f.root, 'missing.git'));
	await writeFile(join(f.home, 'pending'), 'edit');
	const failed = await checkpoint(f.home);
	expect(failed.committed).not.toBeNull();
	expect(failed.pushFailed).toBeDefined();
	await gitIn(f.home, 'remote', 'set-url', 'origin', remote);
	const retried = await checkpoint(f.home);
	expect(retried.committed).toBeNull();
	expect(retried.pushed).toBe(true);
	const peer = join(f.root, 'peer');
	await gitIn(f.root, 'clone', '-q', remote, peer);
	await writeFile(join(peer, 'peer'), 'peer');
	await gitIn(peer, 'add', 'peer');
	await gitIn(peer, 'commit', '-qm', 'peer');
	await gitIn(peer, 'push', '-q');
	const remoteHead = await head(remote);
	await writeFile(join(f.home, 'ours'), 'ours');
	const diverged = await checkpoint(f.home);
	expect(diverged.pushFailed?.message).toContain('nothing was overwritten');
	expect(await head(remote)).toBe(remoteHead);
	expect(await head(f.home)).not.toBe(remoteHead);
});

test('unpushed local paths in deleted and renamed history still refuse push', async () => {
	const f = await setup();
	const remote = join(f.root, 'origin.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(f.home, 'remote', 'add', 'origin', remote);
	await checkpoint(f.home);
	const before = await head(remote);
	await writeFile(join(f.home, 'ordinary'), 'secret');
	await gitIn(f.home, 'add', 'ordinary');
	await gitIn(f.home, 'commit', '-qm', 'ordinary');
	await gitIn(f.home, 'mv', 'ordinary', 'secret.local');
	await gitIn(f.home, 'add', '-f', 'secret.local');
	await gitIn(f.home, 'commit', '-qm', 'rename');
	await gitIn(f.home, 'rm', 'secret.local');
	expect((await checkpoint(f.home)).pushFailed?.message).toContain(
		'secret.local is in commits not yet pushed',
	);
	expect(await head(remote)).toBe(before);
});

test('a code prefix restore keeps newer data; a whole app restore from a code-only commit deletes data', async () => {
	const f = await setup();
	const app = await f.app('x', reading);
	await checkpoint(f.home);
	const codeOnly = await head(f.home);
	await mkdir(join(app, 'data'));
	await writeFile(join(app, 'data/old.md'), 'old');
	await checkpoint(f.home);
	const c1 = await head(f.home);
	await writeFile(join(app, 'code/epicenter.ts'), 'broken');
	await writeFile(join(app, 'data/new.md'), 'new');
	await checkpoint(f.home);
	await gitIn(f.home, 'restore', `--source=${c1}`, '--', 'apps/x/code/');
	expect(await readFile(join(app, 'code/epicenter.ts'), 'utf8')).toContain(
		'defineApp',
	);
	expect(await readFile(join(app, 'data/new.md'), 'utf8')).toBe('new');
	await gitIn(f.home, 'restore', `--source=${codeOnly}`, '--', 'apps/x/');
	expect(await Bun.file(join(app, 'data/new.md')).exists()).toBe(false);
	expect(await Bun.file(join(app, 'data/old.md')).exists()).toBe(false);
});

test('two checkpoint processes serialize into exactly one new commit', async () => {
	const f = await setup();
	await writeFile(join(f.home, 'pending'), 'pending');
	const results = await Promise.all([
		f.run('checkpoint', '--json'),
		f.run('checkpoint', '--json'),
	]);
	for (const result of results) {
		expect(result.code).toBe(0);
		expect(result.stderr).toBe('');
	}
	expect(
		results
			.map((result) => JSON.parse(result.stdout).committed)
			.filter(Boolean),
	).toHaveLength(1);
	expect(await gitIn(f.home, 'rev-list', '--count', 'HEAD')).toBe('2');
});

test('push deadline kills a remote helper and its sleeping child, releases the lock, and retries', async () => {
	const f = await setup();
	const branch = await gitIn(f.home, 'branch', '--show-current');
	const bin = join(f.root, 'bin');
	await mkdir(bin);
	const script = join(bin, 'git-remote-fake');
	const pids = join(f.root, 'push-pids');
	await writeFile(
		script,
		`#!/bin/sh\nsleep 300 &\nchild=$!\necho "$$ $child" > '${pids}'\nwait\n`,
	);
	await chmod(script, 0o755);
	await gitIn(f.home, 'remote', 'add', 'origin', 'fake::x');
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	try {
		await writeFile(join(f.home, 'first'), 'first');
		const start = Date.now();
		const first = await checkpoint(f.home, { pushTimeoutMs: 500 });
		expect(Date.now() - start).toBeLessThan(5000);
		expect(first.committed).not.toBeNull();
		expect(first.pushFailed).toEqual({
			message:
				'push did not finish within 0.5 seconds; the deadline expired and the remote outcome is unconfirmed; the next pass safely retries with an ordinary non-force push',
			next: `for a very large first push, run once by hand: git -C ${f.home} push origin ${first.committed?.commit}:refs/heads/${branch}`,
		});
		const killed = (await readFile(pids, 'utf8')).trim().split(' ').map(Number);
		// A reparented process may briefly be a zombie; wait for the OS to reap it.
		for (let attempt = 0; attempt < 50; attempt++) {
			if (
				killed.every((pid) => {
					try {
						process.kill(pid, 0);
						return false;
					} catch {
						return true;
					}
				})
			)
				break;
			await Bun.sleep(20);
		}
		for (const pid of killed) expect(() => process.kill(pid, 0)).toThrow();
		const lock = await hold(f.home, 0);
		expect(lock).toBeDefined();
		lock?.release();
		await writeFile(join(f.home, 'second'), 'second');
		const second = await checkpoint(f.home, { pushTimeoutMs: 500 });
		expect(second.committed?.files).toBe(1);
		expect(second.pushFailed?.message).toContain('did not finish');
		const backup = join(f.root, 'backup.git');
		await gitIn(f.root, 'init', '--bare', '-q', backup);
		await gitIn(f.home, 'remote', 'set-url', 'origin', backup);
		expect((await checkpoint(f.home)).pushed).toBe(true);
		expect(await head(backup)).toBe(await head(f.home));
	} finally {
		process.env.PATH = previousPath;
	}
});

test('push deadline releases inherited pipes held by a descendant outside its process group', async () => {
	const f = await setup();
	const bin = join(f.root, 'bin');
	await mkdir(bin);
	const pidFile = join(f.root, 'escaped-pid');
	const helper = join(bin, 'git-remote-fake');
	await writeFile(
		helper,
		`#!${process.execPath}
const child = Bun.spawn(['/bin/sleep', '300'], {
  detached: true, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
});
await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
await Bun.sleep(300_000);
`,
	);
	await chmod(helper, 0o755);
	await gitIn(f.home, 'remote', 'add', 'origin', 'fake::x');
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	try {
		const start = Date.now();
		const result = await checkpoint(f.home, { pushTimeoutMs: 500 });
		expect(Date.now() - start).toBeGreaterThanOrEqual(2_400);
		expect(Date.now() - start).toBeLessThan(8_000);
		expect(result.pushFailed?.message).toContain('did not finish');
		const escaped = Number(await readFile(pidFile, 'utf8'));
		// The survivor proves close cannot finish until the parent's pipes are destroyed.
		expect(() => process.kill(escaped, 0)).not.toThrow();
		const lock = await hold(f.home, 0);
		expect(lock).toBeDefined();
		lock?.release();
	} finally {
		process.env.PATH = previousPath;
		const escaped = Number(await readFile(pidFile, 'utf8').catch(() => ''));
		if (escaped) {
			try {
				process.kill(escaped, 'SIGKILL');
			} catch (error) {
				expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
			}
		}
	}
});

test('scoped ignore rules keep Vault renditions and a local mirror out without blocking Vault or a sibling app', async () => {
	const f = await setup();
	const rootIgnore = join(f.home, '.gitignore');
	await writeFile(
		rootIgnore,
		`${await readFile(rootIgnore, 'utf8')}/apps/vault/data/pages/*/renditions/\n`,
	);
	await f.folder(join(f.apps, 'vault'), {
		'.gitignore': 'data/mirror/\n',
		'data/pages/example/page.md': 'page',
		'data/pages/example/renditions/page.pdf': 'rendition bytes',
		'data/mirror/drive/item.json': 'mirror bytes',
	});
	await f.folder(join(f.apps, 'photos'), {
		'data/album.md': 'album',
		'data/pages/example/renditions/cover.jpg': 'durable media',
	});
	const result = await checkpoint(f.home);
	expect(result.failed).toBeUndefined();
	expect(result.committed).not.toBeNull();
	const included = [
		'apps/photos/data/album.md',
		'apps/photos/data/pages/example/renditions/cover.jpg',
		'apps/vault/.gitignore',
		'apps/vault/data/pages/example/page.md',
	].join('\n');
	expect(
		await gitIn(f.home, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'apps/'),
	).toBe(included);
	expect(await gitIn(f.home, 'ls-files', '--', 'apps/')).toBe(included);
	for (const path of [
		'apps/vault/data/pages/example/renditions/page.pdf',
		'apps/vault/data/mirror/drive/item.json',
	]) {
		const blob = await gitIn(f.home, 'hash-object', path);
		await expect(gitIn(f.home, 'cat-file', '-e', blob)).rejects.toThrow();
	}
});

test('empty embedded data repositories and missing LFS filters are refused before staging', async () => {
	const f = await setup();
	// This fixture needs a missing filter even when the person installed it globally.
	await gitIn(f.home, 'config', 'filter.lfs.process', '');
	await f.app('x', reading);
	await mkdir(join(f.apps, 'x/data'));
	await gitIn(join(f.apps, 'x/data'), 'init', '-q');
	expect((await checkpoint(f.home)).failed?.message).toContain(
		'apps/x/data/ is a Git repository',
	);
	await rm(join(f.apps, 'x/data/.git'), { recursive: true });
	await writeFile(join(f.home, '.gitattributes'), '*.bin filter=lfs\n');
	await writeFile(join(f.home, 'record.bin'), 'record');
	expect((await checkpoint(f.home)).failed?.next).toBe('git lfs install');
	expect(await gitIn(f.home, 'diff', '--cached', '--name-only')).toBe('');
});

test('ignored repositories do not block checkpoints while an included nested data repository refuses', async () => {
	const f = await setup();
	const app = await f.app('x', reading);
	const ignore = join(app, 'code/.gitignore');
	await writeFile(ignore, `${await readFile(ignore, 'utf8')}.cache/\n`);
	for (const path of [
		'code/.cache/tool',
		'code/ui/dist/tool',
		'.code-build-copy-fixture',
	]) {
		const directory = join(app, path);
		await mkdir(directory, { recursive: true });
		await gitIn(directory, 'init', '-q');
	}
	await writeFile(join(f.home, 'pending'), 'record this');
	const result = await checkpoint(f.home);
	expect(result.failed).toBeUndefined();
	expect(result.committed).not.toBeNull();
	expect(await gitIn(f.home, 'show', 'HEAD:pending')).toBe('record this');
	const before = await head(f.home);
	const nested = join(app, 'data/sub');
	await mkdir(nested, { recursive: true });
	await gitIn(nested, 'init', '-q');
	const refused = await checkpoint(f.home);
	expect(refused.failed?.message).toContain(
		'apps/x/data/sub/ is a Git repository inside',
	);
	expect(await head(f.home)).toBe(before);
});

test('checkpoint ignores inherited repository redirection and leaves the decoy HEAD and index unchanged', async () => {
	const f = await setup();
	const decoy = await f.folder(
		join(f.root, 'decoy'),
		{ note: 'decoy' },
		{ git: true },
	);
	await writeFile(join(decoy, 'note'), 'staged decoy');
	await gitIn(decoy, 'add', 'note');
	const before = await head(decoy);
	const index = await readFile(join(decoy, '.git/index'));
	await writeFile(join(f.home, 'pending'), 'root edit');
	const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
	const previous = names.map((name) => process.env[name]);
	process.env.GIT_DIR = join(decoy, '.git');
	process.env.GIT_WORK_TREE = decoy;
	process.env.GIT_INDEX_FILE = join(decoy, '.git/index');
	try {
		const result = await checkpoint(f.home);
		expect(result.failed).toBeUndefined();
		expect(result.committed?.files).toBe(1);
	} finally {
		for (const [i, name] of names.entries()) {
			if (previous[i] === undefined) delete process.env[name];
			else process.env[name] = previous[i];
		}
	}
	expect(await gitIn(f.home, 'show', 'HEAD:pending')).toBe('root edit');
	expect(await head(decoy)).toBe(before);
	expect(await readFile(join(decoy, '.git/index'))).toEqual(index);
});

test('local snapshots describe code, records and root changes and retain their exact HEAD when unchanged', async () => {
	const f = await setup();
	await f.folder(f.home, {
		'apps/mail/code/a\tb\nc.ts': 'code',
		'apps/reading/data/note.md': 'record',
		'apps/odd\nname/code/file': 'odd app name',
		'theme.css': 'root change',
	});
	const saved = await snapshot(f.home);
	expect(saved.failed).toBeUndefined();
	expect(saved.committed?.files).toBe(4);
	expect(saved.head).toBe(await head(f.home));
	expect(await gitIn(f.home, 'log', '-1', '--format=%s')).toBe(
		'checkpoint: mail code, other files, reading records, root files',
	);
	const unchanged = await snapshot(f.home);
	expect(unchanged.committed).toBeNull();
	expect(unchanged.head).toBe(saved.head);
});

test('large checkpoint subjects use a factual file count', async () => {
	const f = await setup();
	for (let i = 0; i < 8; i++)
		await f.folder(f.home, {
			[`apps/example-application-${i}/code/file.ts`]: 'code',
		});
	await snapshot(f.home);
	expect(await gitIn(f.home, 'log', '-1', '--format=%s')).toBe(
		'checkpoint: 8 files',
	);
});

test('backup pushes the inspected commit even when another writer commits before Git starts the push', async () => {
	const f = await setup();
	const remote = join(f.root, 'origin.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(f.home, 'remote', 'add', 'origin', remote);
	const bin = join(f.root, 'bin');
	await mkdir(bin);
	const realGit = Bun.which('git');
	if (!realGit) throw new Error('Git is required');
	const wrapper = join(bin, 'git');
	const mark = join(f.root, 'committed-during-upload');
	await writeFile(
		wrapper,
		`#!${process.execPath}
const args = process.argv.slice(2);
if (args[2] === 'push' && !(await Bun.file(${JSON.stringify(mark)}).exists())) {
  await Bun.write(${JSON.stringify(mark)}, 'started');
  await Bun.write(${JSON.stringify(join(f.home, 'secret.local'))}, 'not in the inspected commit');
  for (const command of [['add', '-f', '--', 'secret.local'], ['commit', '--no-verify', '-qm', 'concurrent private change']]) {
    const child = Bun.spawn([${JSON.stringify(realGit)}, '-C', ${JSON.stringify(f.home)}, ...command], { stdout: 'ignore', stderr: 'pipe' });
    if (await child.exited) throw new Error(await new Response(child.stderr).text());
  }
}
const child = Bun.spawn([${JSON.stringify(realGit)}, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
`,
	);
	await chmod(wrapper, 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	try {
		await writeFile(join(f.home, 'first'), 'inspected code');
		const result = await checkpoint(f.home);
		expect(result.pushed).toBe(true);
		if (!result.committed) throw new Error('Expected a new checkpoint');
		expect(await head(remote)).toBe(result.committed.commit);
		expect(await head(f.home)).not.toBe(await head(remote));
		expect((await checkpoint(f.home)).failed?.message).toContain(
			'secret.local',
		);
		expect(await head(remote)).toBe(result.committed.commit);
	} finally {
		process.env.PATH = previousPath;
	}
});
