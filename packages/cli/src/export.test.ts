/**
 * App export tests.
 * Exercise the real CLI and Git boundary: a fresh local checkpoint becomes a flat,
 * owned directory without records or private history. Refreshes replace generated
 * contents, keep Git outside, and materialize shareable theme links.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { checkpoint } from './checkpoint.js';
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
	await writeFile(
		join(f.home, '.gitignore'),
		'*.local\n*.local.*\nnode_modules/\n',
	);
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
	await gitIn(home, 'add', '--', 'EPICENTER.md', '.gitignore', 'apps');
	await gitIn(home, 'commit', '--no-verify', '-qm', 'app snapshot');
}

test('export checkpoints staged and untracked code before copying bytes and modes without private files', async () => {
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
	await gitIn(
		f.home,
		'add',
		'-f',
		'--',
		'apps/tasks/code/tool.sh',
		'apps/tasks/code/binary.bin',
		'apps/tasks/code/node_modules/a/index.js',
		'apps/tasks/code/ui/dist/index.html',
	);
	await gitIn(
		f.home,
		'commit',
		'--no-verify',
		'-qm',
		'binary and ignored fixtures',
	);
	const source = bareApp('latest tasks');
	const sourceCommit = await gitIn(f.home, 'rev-parse', 'HEAD');
	await writeFile(join(f.tasks, 'epicenter.ts'), source);
	await writeFile(join(f.tasks, 'fresh.txt'), 'untracked code');
	await gitIn(f.home, 'add', '--', 'apps/tasks/code/epicenter.ts');
	const run = await f.run('export', 'tasks', f.output, '--json');
	expect(run.code).toBe(0);
	expect(JSON.parse(run.stdout)).toMatchObject({
		commit: await gitIn(f.home, 'rev-parse', 'HEAD'),
		directory: f.output,
		checkpoint: { commit: await gitIn(f.home, 'rev-parse', 'HEAD'), files: 2 },
		apps: [{ app: 'tasks', uncommitted: false }],
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
	expect(await gitIn(f.home, 'rev-parse', 'HEAD')).not.toBe(sourceCommit);
	expect(await gitIn(f.home, 'status', '--porcelain=v1')).toBe('');
	expect(await readFile(join(f.output, 'fresh.txt'), 'utf8')).toBe(
		'untracked code',
	);
});

test('refresh replaces edited code and deleted files while the outer README and Git survive', async () => {
	const f = await setup({ 'apps/tasks/code/old.txt': 'remove me' });
	const output = join(f.output, 'code');
	await mkdir(f.output);
	await writeFile(join(f.output, 'README.md'), 'Handwritten project notes');
	await gitIn(f.output, 'init', '-q');
	await gitIn(f.output, 'config', 'user.name', 'Export Test');
	await gitIn(f.output, 'config', 'user.email', 'export@example.com');
	expect((await f.run('export', 'tasks', output)).code).toBe(0);
	await gitIn(f.output, 'add', '--', 'README.md', 'code');
	await gitIn(f.output, 'commit', '--no-verify', '-qm', 'first publication');
	const publicHead = await gitIn(f.output, 'rev-parse', 'HEAD');
	const inode = (await lstat(output)).ino;
	const markerBefore = await readFile(join(output, EXPORT_MARKER), 'utf8');
	await writeFile(join(output, 'epicenter.ts'), 'a contribution to overwrite');
	await writeFile(
		join(output, 'extra.txt'),
		'generated contents are replaceable',
	);
	const outside = join(f.root, 'precious');
	await mkdir(outside);
	await writeFile(join(outside, 'keep.txt'), 'keep me');
	await symlink(outside, join(output, 'outside'));
	await rm(join(f.tasks, 'old.txt'));
	await writeFile(join(f.tasks, 'new.txt'), 'new source');
	await commit(f.home);
	expect((await f.run('export', 'tasks', output)).code).toBe(0);
	expect((await lstat(output)).ino).toBe(inode);
	expect(await readFile(join(output, 'epicenter.ts'), 'utf8')).toBe(
		bareApp('tasks'),
	);
	for (const path of ['old.txt', 'extra.txt', 'outside'])
		expect(await Bun.file(join(output, path)).exists()).toBe(false);
	expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep me');
	expect(await readFile(join(output, 'new.txt'), 'utf8')).toBe('new source');
	expect(await readFile(join(output, EXPORT_MARKER), 'utf8')).toBe(
		markerBefore,
	);
	expect(JSON.parse(markerBefore)).toEqual({ export: 'app', app: 'tasks' });
	expect(await readFile(join(f.output, 'README.md'), 'utf8')).toBe(
		'Handwritten project notes',
	);
	expect(await gitIn(f.output, 'rev-parse', 'HEAD')).toBe(publicHead);
	expect(await gitIn(f.output, 'diff', '--name-only')).toContain(
		'code/old.txt',
	);
});

for (const path of ['.git', 'nested/.git']) {
	for (const kind of ['file', 'directory']) {
		test(`refresh refuses a ${kind} at ${path} without changing generated contents`, async () => {
			const f = await setup();
			expect((await f.run('export', 'tasks', f.output)).code).toBe(0);
			const target = join(f.output, path);
			await mkdir(join(target, '..'), { recursive: true });
			if (kind === 'directory') {
				await mkdir(target);
				await writeFile(join(target, 'HEAD'), 'valuable public history');
			} else await writeFile(target, 'gitdir: /precious/worktree\n');
			await writeFile(
				join(f.output, 'epicenter.ts'),
				'preserve until Git is moved outside',
			);
			const run = await f.run('export', 'tasks', f.output, '--json');
			expect(run.code).toBe(2);
			expect(JSON.parse(run.stdout).error.message).toContain(
				'keep Git outside',
			);
			expect(await readFile(join(f.output, 'epicenter.ts'), 'utf8')).toBe(
				'preserve until Git is moved outside',
			);
			expect(
				await readFile(
					kind === 'directory' ? join(target, 'HEAD') : target,
					'utf8',
				),
			).toContain(kind === 'directory' ? 'valuable public history' : 'gitdir:');
		});
	}
}

test('Finder metadata does not block creation and disappears on refresh', async () => {
	const f = await setup({ 'apps/tasks/code/ui/index.html': '<html></html>' });
	await mkdir(f.output);
	await writeFile(join(f.output, '.DS_Store'), 'Finder metadata');
	expect((await f.run('export', 'tasks', f.output)).code).toBe(0);
	await writeFile(join(f.output, 'ui/.DS_Store'), 'nested Finder metadata');
	expect((await f.run('export', 'tasks', f.output)).code).toBe(0);
	expect(await Bun.file(join(f.output, 'ui/.DS_Store')).exists()).toBe(false);
});

test('an interrupted collection fill is repaired using its retained ownership marker', async () => {
	const f = await setup();
	await mkdir(join(f.output, 'tasks'), { recursive: true });
	await writeFile(join(f.output, EXPORT_MARKER), '{"export":"all"}\n');
	await writeFile(join(f.output, 'tasks/half.txt'), 'incomplete output');
	await writeFile(join(f.output, 'leftover.txt'), 'incomplete deletion');
	expect((await f.run('export', '--all', f.output)).code).toBe(0);
	expect((await readdir(f.output)).sort()).toEqual([EXPORT_MARKER, 'tasks']);
	expect(await readFile(join(f.output, 'tasks/epicenter.ts'), 'utf8')).toBe(
		bareApp('tasks'),
	);
	expect(await Bun.file(join(f.output, 'tasks/half.txt')).exists()).toBe(false);
	expect(await Bun.file(join(f.output, 'tasks', EXPORT_MARKER)).exists()).toBe(
		false,
	);
});

test('both forms lock their exact destination and release it after refreshing', async () => {
	const f = await setup();
	await mkdir(f.output);
	const held = await hold(f.output, 0);
	expect(held).toBeDefined();
	try {
		for (const args of [
			['--all', f.output],
			['tasks', f.output],
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
	// Children belong to the whole collection and cannot become separate exports.
	expect((await f.run('export', 'tasks', join(f.output, 'tasks'))).code).toBe(
		2,
	);
	const released = await hold(f.output, 0);
	try {
		expect(released).toBeDefined();
	} finally {
		released?.release();
	}
});

test('--all adds future committed apps and removes absent apps without importing code or changing the outer repository', async () => {
	const f = await setup({
		'apps/broken/code/epicenter.ts': 'throw new Error("must not execute");',
	});
	const output = join(f.output, 'apps');
	await mkdir(f.output);
	await writeFile(join(f.output, 'README.md'), 'My apps');
	await gitIn(f.output, 'init', '-q');
	const first = await f.run('export', '--all', output, '--json');
	expect(first.code).toBe(0);
	expect(
		JSON.parse(first.stdout).apps.map((app: { app: string }) => app.app),
	).toEqual(['broken', 'tasks']);
	await f.app(
		'reading',
		'export default defineApp({ description: "Reading", collections: {}, actions: {} });',
	);
	const pending = await f.run('export', '--all', output, '--json');
	expect(pending.code).toBe(0);
	expect(JSON.parse(pending.stdout).omitted).toEqual([]);
	expect(JSON.parse(pending.stdout).apps).toContainEqual(
		expect.objectContaining({ app: 'reading' }),
	);
	expect(JSON.parse(pending.stdout).checkpoint).not.toBeNull();
	expect((await f.run('export', '--all', output)).code).toBe(0);
	expect(await Bun.file(join(output, 'reading/epicenter.ts')).exists()).toBe(
		true,
	);
	await rm(join(f.apps, 'broken'), { recursive: true });
	await commit(f.home);
	expect((await f.run('export', '--all', output)).code).toBe(0);
	expect((await readdir(output)).sort()).toEqual([
		EXPORT_MARKER,
		'reading',
		'tasks',
	]);
	expect(await readFile(join(f.output, 'README.md'), 'utf8')).toBe('My apps');
	expect((await lstat(join(f.output, '.git'))).isDirectory()).toBe(true);
	await rm(join(f.apps, 'tasks'), { recursive: true });
	await rm(join(f.apps, 'reading'), { recursive: true });
	await commit(f.home);
	expect((await f.run('export', '--all', output)).code).toBe(0);
	expect(await readdir(output)).toEqual([EXPORT_MARKER]);
});

test('one invalid app leaves the entire previous collection untouched', async () => {
	const f = await setup({
		'apps/reading/code/epicenter.ts': bareApp('reading'),
	});
	expect((await f.run('export', '--all', f.output)).code).toBe(0);
	await writeFile(
		join(f.output, 'tasks/epicenter.ts'),
		'old collection is left untouched',
	);
	await writeFile(join(f.tasks, 'added.txt'), 'new committed file');
	await symlink('missing.txt', join(f.apps, 'reading/code/link'));
	await commit(f.home);
	const run = await f.run('export', '--all', f.output, '--json');
	expect(run.code).toBe(2);
	expect(JSON.parse(run.stdout).error.message).toContain('broken or cyclic');
	expect(await readFile(join(f.output, 'tasks/epicenter.ts'), 'utf8')).toBe(
		'old collection is left untouched',
	);
	expect(await Bun.file(join(f.output, 'tasks/added.txt')).exists()).toBe(
		false,
	);
	expect(await Bun.file(join(f.output, 'reading/link')).exists()).toBe(false);
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
	const before = await gitIn(f.home, 'rev-parse', 'HEAD');
	await writeFile(
		join(f.tasks, 'new.txt'),
		'not checkpointed for a refused destination',
	);
	expect((await f.run('export', 'tasks', f.output)).code).toBe(2);
	expect(await gitIn(f.home, 'rev-parse', 'HEAD')).toBe(before);
	expect(await readFile(join(f.output, 'keep.txt'), 'utf8')).toBe('precious');
	await rm(f.output, { recursive: true });
	expect((await f.run('export', 'tasks', f.output)).code).toBe(0);
	await f.app(
		'reading',
		'export default defineApp({ description: "Reading", collections: {}, actions: {} });',
	);
	await commit(f.home);
	expect((await f.run('export', 'reading', f.output)).code).toBe(2);
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
		uncommitted: false,
		materialized: [{ path: 'ui/theme.css', from: 'theme.css' }],
	});
	expect((await lstat(join(f.output, 'ui/theme.css'))).isFile()).toBe(true);
	expect(await readFile(join(f.output, 'ui/theme.css'), 'utf8')).toBe(
		'uncommitted shared theme',
	);
	expect(await readlink(join(f.output, 'ui/internal.css'))).toBe(
		'theme-copy.css',
	);
	await f.folder(f.home, {
		'apps/reading/code/epicenter.ts': bareApp('reading'),
		'apps/reading/code/ui/base.css': 'body {}',
	});
	await symlink(
		'../../../../theme.css',
		join(f.apps, 'reading/code/ui/theme.css'),
	);
	await symlink('../../../../theme.css', join(f.tasks, 'ui/theme-second.css'));
	await commit(f.home);
	const collection = join(f.root, 'collection/apps');
	expect((await f.run('export', '--all', collection)).code).toBe(0);
	for (const path of [
		'reading/ui/theme.css',
		'tasks/ui/theme.css',
		'tasks/ui/theme-second.css',
	]) {
		expect((await lstat(join(collection, path))).isFile()).toBe(true);
		expect(await readFile(join(collection, path), 'utf8')).toBe(
			'uncommitted shared theme',
		);
	}
});

test('links that escape and reenter through the checkout directory name are refused in both export forms', async () => {
	for (const [app, target] of [
		['tasks', '../../code/ui/base.css'],
		['tasks', 'alias/../code/ui/base.css'],
		['code', 'alias/../code/ui/base.css'],
	] as const) {
		const f = await setup({
			[`apps/${app}/code/epicenter.ts`]: bareApp(app),
			[`apps/${app}/code/ui/base.css`]: 'portable bytes',
		});
		const single = join(f.root, 'project/code');
		const collection = join(f.root, 'collection/apps');
		for (const args of [
			[app, single],
			['--all', collection],
		])
			expect((await f.run('export', ...args)).code).toBe(0);
		await symlink('..', join(f.apps, app, 'code/ui/alias'));
		await symlink(target, join(f.apps, app, 'code/ui/link'));
		await commit(f.home);
		for (const [args, output] of [
			[[app, single], single],
			[['--all', collection], join(collection, app)],
		] as const) {
			const run = await f.run('export', ...args, '--json');
			expect(run.code).toBe(2);
			expect(await readFile(join(output, 'ui/base.css'), 'utf8')).toBe(
				'portable bytes',
			);
			expect(await Bun.file(join(output, 'ui/link')).exists()).toBe(false);
		}
	}
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
		expect(run.code).toBe(2);
		expect(JSON.parse(run.stdout).error).toBeDefined();
		expect(await readFile(join(f.output, EXPORT_MARKER), 'utf8')).toBe(before);
		expect(await Bun.file(join(f.output, 'link')).exists()).toBe(false);
	}
});

test('an exported collection is accepted by new --from and does not copy the export marker', async () => {
	const f = await setup();
	expect((await f.run('export', '--all', join(f.output, 'apps'))).code).toBe(0);
	await gitIn(f.output, 'init', '-q');
	await gitIn(f.output, 'config', 'user.name', 'Export Test');
	await gitIn(f.output, 'config', 'user.email', 'export@example.com');
	await gitIn(f.output, 'add', '--', 'apps');
	await gitIn(f.output, 'commit', '--no-verify', '-qm', 'public code');
	const copied = await f.run(
		'new',
		'copy',
		'--from',
		`file://${f.output}#apps/tasks`,
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
		expect(missing.code).toBe(2);
		expect(JSON.parse(missing.stdout).error).toBeDefined();
		expect(await readFile(join(f.output, EXPORT_MARKER), 'utf8')).toBe(
			oldMarker,
		);
	});
}

test('invalid and old digest markers are refused without adopting their contents', async () => {
	const f = await setup();
	await mkdir(f.output);
	await writeFile(join(f.output, 'keep.txt'), 'precious');
	for (const marker of [
		'not json',
		'{"export":"all","extra":true}',
		'{"app":"tasks","digest":"sha256:old"}',
	]) {
		await writeFile(join(f.output, EXPORT_MARKER), marker);
		expect((await f.run('export', '--all', f.output)).code).toBe(2);
		expect(await readFile(join(f.output, 'keep.txt'), 'utf8')).toBe('precious');
	}
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

test('export saves locally without contacting the backup, which a later checkpoint can upload', async () => {
	const f = await setup();
	const bin = join(f.root, 'bin');
	await mkdir(bin);
	const touched = join(f.root, 'backup-contacted');
	const helper = join(bin, 'git-remote-observe');
	await writeFile(
		helper,
		`#!${process.execPath}
await Bun.write(${JSON.stringify(touched)}, 'contacted');
process.exit(1);
`,
	);
	await chmod(helper, 0o755);
	f.env.PATH = `${bin}:${f.env.PATH}`;
	await gitIn(f.home, 'remote', 'add', 'origin', 'observe::backup');
	await writeFile(join(f.tasks, 'latest.txt'), 'latest code');
	const exported = await f.run('export', '--all', f.output, '--json');
	expect(exported.code).toBe(0);
	const report = JSON.parse(exported.stdout);
	expect(report.commit).toBe(await gitIn(f.home, 'rev-parse', 'HEAD'));
	expect(report.checkpoint.commit).toBe(report.commit);
	expect(await Bun.file(touched).exists()).toBe(false);
	expect(await readFile(join(f.output, 'tasks/latest.txt'), 'utf8')).toBe(
		'latest code',
	);
	const remote = join(f.root, 'origin.git');
	await gitIn(f.root, 'init', '--bare', '-q', remote);
	await gitIn(f.home, 'remote', 'set-url', 'origin', remote);
	const backedUp = await f.run('checkpoint', '--json');
	expect(backedUp.code).toBe(0);
	expect(JSON.parse(backedUp.stdout)).toMatchObject({
		committed: null,
		pushed: true,
	});
	expect(await gitIn(remote, 'rev-parse', 'HEAD')).toBe(report.commit);
});

test('a refused local checkpoint never replaces the previous export with stale code', async () => {
	const f = await setup();
	expect((await f.run('export', '--all', f.output)).code).toBe(0);
	const before = await gitIn(f.home, 'rev-parse', 'HEAD');
	const code = await readFile(join(f.output, 'tasks/epicenter.ts'), 'utf8');
	await writeFile(join(f.tasks, 'fresh.txt'), 'pending code');
	await writeFile(join(f.home, '.gitignore'), '');
	await writeFile(join(f.home, 'secret.local'), 'do not checkpoint');
	const refused = await f.run('export', '--all', f.output, '--json');
	expect(refused.code).toBe(2);
	expect(JSON.parse(refused.stdout).error.message).toContain('secret.local');
	expect(await gitIn(f.home, 'rev-parse', 'HEAD')).toBe(before);
	await rm(join(f.home, 'secret.local'));
	await writeFile(join(f.home, '.git/MERGE_HEAD'), `${before}\n`);
	const deferred = await f.run('export', '--all', f.output, '--json');
	expect(deferred.code).toBe(2);
	expect(JSON.parse(deferred.stdout).error.message).toContain('merge');
	expect(await gitIn(f.home, 'rev-parse', 'HEAD')).toBe(before);
	expect(await readFile(join(f.output, 'tasks/epicenter.ts'), 'utf8')).toBe(
		code,
	);
	expect(await Bun.file(join(f.output, 'tasks/fresh.txt')).exists()).toBe(
		false,
	);
});

test('a slow backup releases the local snapshot lock so export can save newer code', async () => {
	const f = await setup();
	const bin = join(f.root, 'bin');
	await mkdir(bin);
	const ready = join(f.root, 'upload-started');
	const helper = join(bin, 'git-remote-slow');
	await writeFile(
		helper,
		`#!${process.execPath}
await Bun.write(${JSON.stringify(ready)}, 'uploading');
await Bun.sleep(300_000);
`,
	);
	await chmod(helper, 0o755);
	await gitIn(f.home, 'remote', 'add', 'origin', 'slow::backup');
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	let finished = false;
	const upload = checkpoint(f.home, { pushTimeoutMs: 5000 }).finally(() => {
		finished = true;
	});
	try {
		for (let i = 0; i < 200 && !(await Bun.file(ready).exists()); i++)
			await Bun.sleep(10);
		expect(await Bun.file(ready).exists()).toBe(true);
		expect(finished).toBe(false);
		const held = await hold(f.home, 0);
		try {
			expect(held).toBeDefined();
		} finally {
			held?.release();
		}
		await writeFile(join(f.tasks, 'while-uploading.txt'), 'newer code');
		const exported = await f.run('export', '--all', f.output, '--json');
		expect(exported.code).toBe(0);
		expect(
			await readFile(join(f.output, 'tasks/while-uploading.txt'), 'utf8'),
		).toBe('newer code');
		expect(finished).toBe(false);
	} finally {
		await upload;
		process.env.PATH = previousPath;
	}
});
