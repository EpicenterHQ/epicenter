/**
 * App export tests.
 * Exercise the real CLI and Git boundary: committed code becomes a flat,
 * refreshable app without records or private history. Reruns preserve Git,
 * refuse edited destinations, and materialize shareable theme links.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { EXPORT_MARKER } from './code-copy.js';
import { hold } from './lock.js';
import { bareApp, fixture, gitIn } from './runner.test-support.js';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function setup(files: Record<string, string> = {}) {
	const f = await fixture();
	roots.push(f.root);
	await f.folder(f.home, {
		'apps/tasks/code/epicenter.ts': bareApp('tasks'),
		'apps/tasks/code/.gitignore': 'node_modules/\nui/dist/\n',
		...files,
	});
	await gitIn(f.home, 'init', '-q');
	await gitIn(f.home, 'config', 'user.name', 'Export Test');
	await gitIn(f.home, 'config', 'user.email', 'export@example.com');
	await commit(f.home);
	return {
		...f,
		output: join(f.root, 'shared-apps'),
		tasks: join(f.apps, 'tasks/code'),
	};
}

async function commit(home: string) {
	await gitIn(home, 'add', '--', 'EPICENTER.md', 'apps');
	await gitIn(home, 'commit', '--no-verify', '-qm', 'app snapshot');
}

test('single export copies committed bytes and modes at the root without records, caches, provenance, or private history', async () => {
	const f = await setup({
		'apps/tasks/code/tool.sh': '#!/bin/sh\nprintf hello\n',
		'apps/tasks/code/data/private.md': 'private record',
		'apps/tasks/code/key.local.json': 'private credential',
		'apps/tasks/code/SOURCE.md': '/private/source/path',
		'apps/tasks/data/record.md': 'private sibling',
	});
	const bytes = new Uint8Array([0, 255, 128, 10, 0, 13]);
	await writeFile(join(f.tasks, 'binary.bin'), bytes);
	await chmod(join(f.tasks, 'tool.sh'), 0o755);
	await mkdir(join(f.tasks, 'node_modules/a'), { recursive: true });
	await writeFile(join(f.tasks, 'node_modules/a/index.js'), 'dependency');
	await mkdir(join(f.tasks, 'ui/dist'), { recursive: true });
	await writeFile(join(f.tasks, 'ui/dist/index.html'), 'build output');
	await gitIn(f.home, 'add', '-f', '--', 'apps/tasks/code');
	await gitIn(
		f.home,
		'commit',
		'--no-verify',
		'-qm',
		'binary and ignored fixtures',
	);
	const source = await readFile(join(f.tasks, 'epicenter.ts'), 'utf8');
	const sourceCommit = await gitIn(f.home, 'rev-parse', 'HEAD');
	await writeFile(join(f.tasks, 'epicenter.ts'), 'uncommitted edit');
	await gitIn(f.home, 'add', '--', 'apps/tasks/code/epicenter.ts');
	const before = {
		index: await readFile(join(f.home, '.git/index')),
		status: await gitIn(f.home, 'status', '--porcelain=v1'),
		refs: await gitIn(f.home, 'show-ref'),
	};
	const run = await f.run('export', 'tasks', f.output, '--json');
	expect(run.code).toBe(0);
	expect(JSON.parse(run.stdout)).toMatchObject({
		commit: sourceCommit,
		apps: [{ app: 'tasks', status: 'created', uncommitted: true }],
	});
	expect(await readFile(join(f.output, 'epicenter.ts'), 'utf8')).toBe(source);
	expect(new Uint8Array(await readFile(join(f.output, 'binary.bin')))).toEqual(
		bytes,
	);
	expect((await lstat(join(f.output, 'tool.sh'))).mode & 0o111).not.toBe(0);
	for (const path of [
		'code',
		'data',
		'key.local.json',
		'SOURCE.md',
		'node_modules',
		'ui/dist',
		'.git',
	])
		expect(await Bun.file(join(f.output, path)).exists()).toBe(false);
	expect(await readFile(join(f.home, '.git/index'))).toEqual(before.index);
	expect(await gitIn(f.home, 'status', '--porcelain=v1')).toBe(before.status);
	expect(await gitIn(f.home, 'show-ref')).toBe(before.refs);
});

test('refresh removes deleted source files, adds new ones, and leaves unchanged exports and standalone Git intact', async () => {
	const f = await setup({ 'apps/tasks/code/old.txt': 'remove me' });
	expect((await f.run('export', 'tasks', f.output)).code).toBe(0);
	await gitIn(f.output, 'init', '-q');
	await gitIn(f.output, 'config', 'user.name', 'Export Test');
	await gitIn(f.output, 'config', 'user.email', 'export@example.com');
	await gitIn(
		f.output,
		'add',
		'--',
		'.gitignore',
		'epicenter.ts',
		'old.txt',
		EXPORT_MARKER,
	);
	await gitIn(f.output, 'commit', '--no-verify', '-qm', 'first publication');
	const publicHead = await gitIn(f.output, 'rev-parse', 'HEAD');
	const marker = join(f.output, EXPORT_MARKER);
	const markerBefore = await lstat(marker);
	const unchanged = await f.run('export', 'tasks', f.output, '--json');
	expect(JSON.parse(unchanged.stdout).apps[0].status).toBe('unchanged');
	expect((await lstat(marker)).mtimeMs).toBe(markerBefore.mtimeMs);
	await rm(join(f.tasks, 'old.txt'));
	await writeFile(join(f.tasks, 'new.txt'), 'new source');
	await commit(f.home);
	const updated = await f.run('export', 'tasks', f.output, '--json');
	expect(updated.code).toBe(0);
	expect(JSON.parse(updated.stdout).apps[0].status).toBe('updated');
	expect(await Bun.file(join(f.output, 'old.txt')).exists()).toBe(false);
	expect(await readFile(join(f.output, 'new.txt'), 'utf8')).toBe('new source');
	expect(await gitIn(f.output, 'rev-parse', 'HEAD')).toBe(publicHead);
	expect(await gitIn(f.output, 'diff', '--name-only')).toContain('old.txt');
	expect(
		Object.keys(JSON.parse(await readFile(marker, 'utf8'))).sort(),
	).toEqual(['app', 'digest']);
});

test('refresh preserves a standalone worktree Git file', async () => {
	const f = await setup();
	expect((await f.run('export', 'tasks', f.output)).code).toBe(0);
	const gitFile = 'gitdir: ../elsewhere/.git/worktrees/tasks\n';
	await writeFile(join(f.output, '.git'), gitFile);
	await writeFile(join(f.tasks, 'added.txt'), 'added');
	await commit(f.home);
	expect((await f.run('export', 'tasks', f.output)).code).toBe(0);
	expect(await readFile(join(f.output, '.git'), 'utf8')).toBe(gitFile);
});

test('Finder metadata does not block creating or refreshing an export', async () => {
	const f = await setup({ 'apps/tasks/code/ui/index.html': '<html></html>' });
	await mkdir(f.output);
	await writeFile(join(f.output, '.DS_Store'), 'Finder metadata');
	expect((await f.run('export', 'tasks', f.output)).code).toBe(0);
	await writeFile(join(f.output, '.DS_Store'), 'Finder metadata');
	await writeFile(join(f.output, 'ui/.DS_Store'), 'nested Finder metadata');
	expect(
		JSON.parse((await f.run('export', 'tasks', f.output, '--json')).stdout)
			.apps[0].status,
	).toBe('unchanged');
	await writeFile(join(f.tasks, 'new.txt'), 'new');
	await commit(f.home);
	expect(
		JSON.parse((await f.run('export', 'tasks', f.output, '--json')).stdout)
			.apps[0].status,
	).toBe('updated');
});

test('unfinished export work preserves recovery Git metadata and blocks fresh single and all exports', async () => {
	const f = await setup();
	const recovery = join(
		f.output,
		'.epicenter-export-interrupted/previous/.git',
	);
	await mkdir(recovery, { recursive: true });
	await writeFile(join(recovery, 'HEAD'), 'valuable public history');
	const single = await f.run(
		'export',
		'tasks',
		join(f.output, 'tasks'),
		'--json',
	);
	expect(single.code).toBe(2);
	expect(JSON.parse(single.stdout).error.message).toContain(
		'Unfinished export directories',
	);
	const all = await f.run('export', '--all', f.output, '--json');
	expect(all.code).toBe(2);
	expect(JSON.parse(all.stdout).error.message).toContain(
		'Unfinished export directories',
	);
	expect(await Bun.file(join(f.output, 'tasks/epicenter.ts')).exists()).toBe(
		false,
	);
	expect(await readFile(join(recovery, 'HEAD'), 'utf8')).toBe(
		'valuable public history',
	);
});

test('single and all exports honor the same collection lock and release it after success', async () => {
	const f = await setup();
	await mkdir(f.output);
	const held = await hold(f.output, 0);
	expect(held).toBeDefined();
	try {
		for (const args of [
			['--all', f.output],
			['tasks', join(f.output, 'tasks')],
		]) {
			const run = await f.run('export', ...args, '--json');
			expect(run.code).toBe(2);
			expect(JSON.parse(run.stdout).error.message).toContain('another export');
			expect(await readdir(f.output)).toEqual([]);
		}
	} finally {
		held?.release();
	}
	expect((await f.run('export', '--all', f.output)).code).toBe(0);
	expect((await f.run('export', 'tasks', join(f.output, 'tasks'))).code).toBe(
		0,
	);
	const released = await hold(f.output, 0);
	try {
		expect(released).toBeDefined();
	} finally {
		released?.release();
	}
});

test('--all exports future apps without importing code, preserves collection files, and reports removed apps as stale', async () => {
	const f = await setup({
		'apps/broken/code/epicenter.ts': 'throw new Error("must not execute");',
	});
	await mkdir(f.output);
	await writeFile(join(f.output, 'README.md'), 'My apps');
	await gitIn(f.output, 'init', '-q');
	const first = await f.run('export', '--all', f.output, '--json');
	expect(first.code).toBe(0);
	expect(
		JSON.parse(first.stdout).apps.map((app: { app: string }) => app.app),
	).toEqual(['broken', 'tasks']);
	await f.app(
		'reading',
		'export default defineApp({ description: "Reading", collections: {}, actions: {} });',
	);
	const pending = await f.run('export', '--all', f.output, '--json');
	expect(pending.code).toBe(1);
	expect(JSON.parse(pending.stdout).omitted).toContain('reading');
	await commit(f.home);
	const future = await f.run('export', '--all', f.output, '--json');
	expect(future.code).toBe(0);
	expect(JSON.parse(future.stdout).apps).toContainEqual(
		expect.objectContaining({ app: 'reading', status: 'created' }),
	);
	expect(await Bun.file(join(f.output, 'reading/epicenter.ts')).exists()).toBe(
		true,
	);
	await rm(join(f.apps, 'broken'), { recursive: true });
	await commit(f.home);
	const stale = await f.run('export', '--all', f.output, '--json');
	expect(stale.code).toBe(1);
	expect(JSON.parse(stale.stdout).apps).toContainEqual(
		expect.objectContaining({ app: 'broken', status: 'stale' }),
	);
	expect(await Bun.file(join(f.output, 'broken/epicenter.ts')).exists()).toBe(
		true,
	);
	expect(await readFile(join(f.output, 'README.md'), 'utf8')).toBe('My apps');
	expect((await lstat(join(f.output, '.git'))).isDirectory()).toBe(true);
	await rename(join(f.output, 'tasks'), join(f.output, 'todo'));
	const renamed = await f.run('export', '--all', f.output, '--json');
	expect(JSON.parse(renamed.stdout).apps).toContainEqual(
		expect.objectContaining({
			app: 'tasks',
			directory: join(f.output, 'todo'),
			status: 'stale',
			problem: expect.stringContaining('Extra export of tasks'),
		}),
	);
});

test('edited exports are refused while --all still refreshes the other apps', async () => {
	const f = await setup({
		'apps/reading/code/epicenter.ts': bareApp('reading'),
	});
	expect((await f.run('export', '--all', f.output)).code).toBe(0);
	await gitIn(f.output, 'init', '-q');
	await gitIn(f.output, 'config', 'user.name', 'Export Test');
	await gitIn(f.output, 'config', 'user.email', 'export@example.com');
	await gitIn(f.output, 'add', '--', 'tasks', 'reading');
	await gitIn(f.output, 'commit', '--no-verify', '-qm', 'first publication');
	await writeFile(join(f.output, 'tasks/epicenter.ts'), 'a contribution');
	await gitIn(f.output, 'add', '--', 'tasks/epicenter.ts');
	await gitIn(f.output, 'commit', '--no-verify', '-qm', 'public contribution');
	await writeFile(join(f.apps, 'reading/code/added.txt'), 'new');
	await commit(f.home);
	const run = await f.run('export', '--all', f.output, '--json');
	expect(run.code).toBe(1);
	expect(JSON.parse(run.stdout).apps).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				app: 'tasks',
				status: 'refused',
				problem: expect.stringContaining('changed since'),
			}),
			expect.objectContaining({ app: 'reading', status: 'updated' }),
		]),
	);
	expect(await readFile(join(f.output, 'tasks/epicenter.ts'), 'utf8')).toBe(
		'a contribution',
	);
	expect(await readFile(join(f.output, 'reading/added.txt'), 'utf8')).toBe(
		'new',
	);
	expect(
		(await readdir(f.output)).some((name) =>
			name.startsWith('.epicenter-export-'),
		),
	).toBe(false);
});

test('destinations inside, containing, or aliasing the live Epicenter are refused without touching files', async () => {
	const f = await setup();
	await symlink(f.home, join(f.root, 'alias'));
	for (const destination of [
		f.home,
		f.tasks,
		join(f.home, 'exports'),
		f.root,
		join(f.root, 'alias/exports'),
	]) {
		const run = await f.run('export', 'tasks', destination, '--json');
		expect(run.code).toBe(2);
		expect(JSON.parse(run.stdout).error.message).toContain('overlaps');
	}
	expect(await readFile(join(f.tasks, 'epicenter.ts'), 'utf8')).toBe(
		bareApp('tasks'),
	);
});

test('unowned directories, another app export, and symlinked targets are refused', async () => {
	const f = await setup();
	await mkdir(f.output);
	await writeFile(join(f.output, 'keep.txt'), 'precious');
	expect((await f.run('export', 'tasks', f.output)).code).toBe(1);
	expect(await readFile(join(f.output, 'keep.txt'), 'utf8')).toBe('precious');
	await rm(f.output, { recursive: true });
	expect((await f.run('export', 'tasks', f.output)).code).toBe(0);
	await f.app(
		'reading',
		'export default defineApp({ description: "Reading", collections: {}, actions: {} });',
	);
	await commit(f.home);
	expect((await f.run('export', 'reading', f.output)).code).toBe(1);
	const alias = join(f.root, 'export-alias');
	await symlink(f.output, alias);
	expect((await f.run('export', 'tasks', alias)).code).toBe(2);
	expect((await f.run('export', '--all', f.output)).code).toBe(2);
});

test('theme links copy committed shared bytes and internal links retain their targets', async () => {
	const f = await setup({
		'apps/tasks/code/ui/theme-copy.css': 'body { color: blue; }',
	});
	await writeFile(join(f.home, 'theme.css'), 'body { color: red; }');
	await symlink('../../../../theme.css', join(f.tasks, 'ui/theme.css'));
	await symlink('theme-copy.css', join(f.tasks, 'ui/internal.css'));
	await gitIn(f.home, 'add', '--', 'theme.css');
	await commit(f.home);
	await writeFile(join(f.home, 'theme.css'), 'uncommitted shared theme');
	const run = await f.run('export', 'tasks', f.output, '--json');
	expect(run.code).toBe(0);
	expect(JSON.parse(run.stdout).apps[0]).toMatchObject({
		uncommitted: true,
		materialized: [{ path: 'ui/theme.css', from: 'theme.css' }],
	});
	expect((await lstat(join(f.output, 'ui/theme.css'))).isFile()).toBe(true);
	expect(await readFile(join(f.output, 'ui/theme.css'), 'utf8')).toBe(
		'body { color: red; }',
	);
	expect(await readlink(join(f.output, 'ui/internal.css'))).toBe(
		'theme-copy.css',
	);
});

test('links to data, excluded code, missing files, external paths, and shared directories leave the previous export intact', async () => {
	const f = await setup({
		'apps/tasks/data/private.md': 'private',
		'apps/tasks/code/key.local': 'credential',
		'apps/tasks/code/other/keep.txt': 'included directory',
		'apps/tasks/code/allowed.txt': 'included file',
	});
	await mkdir(join(f.tasks, 'ui'));
	await symlink('../other', join(f.tasks, 'ui/alias'));
	await commit(f.home);
	expect((await f.run('export', 'tasks', f.output)).code).toBe(0);
	const before = await readFile(join(f.output, EXPORT_MARKER), 'utf8');
	for (const target of [
		'../data/private.md',
		'key.local',
		'missing.txt',
		'/etc/passwd',
		'../../../../outside',
		'../../..',
		'ui/alias/../../allowed.txt',
	]) {
		await rm(join(f.tasks, 'link'), { force: true });
		await symlink(target, join(f.tasks, 'link'));
		await commit(f.home);
		const run = await f.run('export', 'tasks', f.output, '--json');
		expect(run.code).toBe(1);
		expect(JSON.parse(run.stdout).apps[0].status).toBe('refused');
		expect(await readFile(join(f.output, EXPORT_MARKER), 'utf8')).toBe(before);
		expect(await Bun.file(join(f.output, 'link')).exists()).toBe(false);
	}
});

test('an exported collection is accepted by new --from and does not copy the export marker', async () => {
	const f = await setup();
	expect((await f.run('export', '--all', f.output)).code).toBe(0);
	await gitIn(f.output, 'init', '-q');
	await gitIn(f.output, 'config', 'user.name', 'Export Test');
	await gitIn(f.output, 'config', 'user.email', 'export@example.com');
	await gitIn(f.output, 'add', '--', 'tasks');
	await gitIn(f.output, 'commit', '--no-verify', '-qm', 'public code');
	const copied = await f.run(
		'new',
		'copy',
		'--from',
		`file://${f.output}#tasks`,
		'--json',
	);
	expect(copied.code).toBe(0);
	expect(await readFile(join(f.apps, 'copy/code/epicenter.ts'), 'utf8')).toBe(
		bareApp('tasks'),
	);
	expect(
		await Bun.file(join(f.apps, 'copy/code', EXPORT_MARKER)).exists(),
	).toBe(false);
	expect((await f.run('copy', '--json')).code).toBe(0);
});

for (const storage of [undefined, 'custom-lfs']) {
	test(`LFS bytes are materialized from ${storage ?? 'default'} storage and missing objects preserve the export`, async () => {
		const f = await setup({
			'apps/tasks/code/asset.bin': 'materialized binary fixture',
		});
		await writeFile(
			join(f.home, '.gitattributes'),
			'*.bin filter=lfs diff=lfs merge=lfs -text\n',
		);
		if (storage) await gitIn(f.home, 'config', 'lfs.storage', storage);
		await gitIn(f.home, 'lfs', 'install', '--local');
		await gitIn(f.home, 'add', '--', '.gitattributes');
		await gitIn(
			f.home,
			'add',
			'--renormalize',
			'--',
			'apps/tasks/code/asset.bin',
		);
		await gitIn(f.home, 'commit', '--no-verify', '-qm', 'LFS fixture');
		const pointer = await gitIn(
			f.home,
			'show',
			'HEAD:apps/tasks/code/asset.bin',
		);
		expect(pointer).toContain('version https://git-lfs.github.com/spec/v1');
		const run = await f.run('export', 'tasks', f.output, '--json');
		expect(run.code).toBe(0);
		expect(await readFile(join(f.output, 'asset.bin'), 'utf8')).toBe(
			'materialized binary fixture',
		);
		const oldMarker = await readFile(join(f.output, EXPORT_MARKER), 'utf8');
		const oid = /oid sha256:([0-9a-f]+)/.exec(pointer)![1]!;
		await rm(
			join(
				f.home,
				'.git',
				storage ?? 'lfs',
				'objects',
				oid.slice(0, 2),
				oid.slice(2, 4),
				oid,
			),
		);
		const missing = await f.run('export', 'tasks', f.output, '--json');
		expect(missing.code).toBe(1);
		expect(JSON.parse(missing.stdout).apps[0].status).toBe('failed');
		expect(await readFile(join(f.output, EXPORT_MARKER), 'utf8')).toBe(
			oldMarker,
		);
	});
}

test('--all reports malformed stale markers without hiding completed exports', async () => {
	const f = await setup();
	await mkdir(join(f.output, 'old-app'), { recursive: true });
	await writeFile(join(f.output, 'old-app', EXPORT_MARKER), 'not json');
	const run = await f.run('export', '--all', f.output, '--json');
	expect(run.code).toBe(1);
	expect(JSON.parse(run.stdout).apps).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ app: 'tasks', status: 'created' }),
			expect.objectContaining({ app: 'old-app', status: 'refused' }),
		]),
	);
});

test('export help and argument validation reserve the command and reject ambiguous invocations', async () => {
	const f = await setup();
	const help = await f.run('export', '--help');
	expect(help.code).toBe(0);
	expect(help.stdout).toContain('epicenter export --all <directory>');
	for (const args of [
		[],
		['tasks'],
		['--all'],
		['--all', 'tasks', f.output],
		['tasks', f.output, 'extra'],
		['--unknown', f.output],
		['../tasks', f.output],
	])
		expect((await f.run('export', ...args, '--json')).code).toBe(2);
	expect((await f.run('new', 'export', '--json')).code).toBe(2);
});
