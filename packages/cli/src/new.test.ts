/** New apps use code/data containers; source copies preserve committed modes and links while excluding records and caches. */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	lstat,
	mkdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, gitIn, header } from './runner.test-support.ts';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
async function setup() {
	const f = await fixture();
	roots.push(f.root);
	return f;
}

/** Point a GitHub repository at a local one, through Git's own URL rewriting. */
function github(
	f: Awaited<ReturnType<typeof setup>>,
	repo: string,
	path: string,
) {
	const n = Number(f.env.GIT_CONFIG_COUNT ?? 0);
	f.env[`GIT_CONFIG_KEY_${n}`] = `url.file://${path}.insteadOf`;
	f.env[`GIT_CONFIG_VALUE_${n}`] = `https://github.com/${repo}.git`;
	f.env.GIT_CONFIG_COUNT = String(n + 1);
}

async function noNestedGit(folder: string): Promise<void> {
	const { readdir } = await import('node:fs/promises');
	for (const entry of await readdir(folder, { withFileTypes: true })) {
		expect(entry.name).not.toBe('.git');
		if (entry.isDirectory()) await noNestedGit(join(folder, entry.name));
	}
}

test('new copies a UI without installing or building, and prints the one command that does both', async () => {
	const f = await setup();
	const source = await f.folder(
		join(f.root, 'source'),
		{
			'epicenter.ts': `${header}export default defineApp({description:'Garden',actions:{}});`,
			'package.json': JSON.stringify({ scripts: { build: 'touch built' } }),
			'ui/index.html': '<h1>Garden</h1>',
		},
		{ git: true },
	);
	const made = await f.run('new', 'garden', '--from', source);
	expect(made.code).toBe(0);
	expect(made.stderr).toBe(
		`Run: cd ${f.home} && bun install && bun run build\n`,
	);
	const code = join(f.apps, 'garden', 'code');
	expect(existsSync(join(code, 'built'))).toBe(false);
	expect(existsSync(join(code, 'ui', 'dist'))).toBe(false);
	expect(existsSync(join(f.home, 'bun.lock'))).toBe(false);
});

test('new creates code and empty data without repositories and refuses taken and reserved names', async () => {
	const f = await setup();
	await gitIn(f.home, 'init', '-q');
	await mkdir(join(f.apps, 'Reading'));
	for (const name of ['reading', 'serve', 'init', 'Bad_Name'])
		expect((await f.run('new', name, '--json')).code).toBe(2);
	expect(JSON.parse((await f.run('new', 'reading', '--json')).stdout)).toEqual({
		data: null,
		error: {
			name: 'NotStarted',
			cause: 'usage',
			message: `reading already exists in ${f.apps}`,
			namespace: 'epicenter/action-error',
		},
	});
	const made = await f.run('new', 'garden', '--json');
	expect(made.code).toBe(0);
	const container = join(f.apps, 'garden');
	expect(JSON.parse(made.stdout)).toEqual({
		data: { name: 'garden', folder: container },
		error: null,
	});
	expect(await readFile(join(container, 'code/.gitignore'), 'utf8')).toBe(
		'node_modules/\nui/dist/\n',
	);
	expect((await lstat(join(container, 'data'))).isDirectory()).toBe(true);
	// A package of the home's workspace, named for the app, that lists nothing:
	// @epicenter/app comes from the home, which holds the one lock and install.
	expect(await Bun.file(join(container, 'code/package.json')).json()).toEqual({
		name: 'garden',
		private: true,
	});
	for (const path of ['code/bun.lock', 'code/node_modules', 'node_modules'])
		expect(existsSync(join(container, path))).toBe(false);
	expect((await f.run('garden', '--json')).code).toBe(0);
	await noNestedGit(f.apps);
});

for (const form of [
	'root',
	'github-root',
	'github-folder',
	'local-folder',
	'container',
] as const) {
	test(`new --from copies committed code from ${form}, excludes records and caches, and records provenance`, async () => {
		const f = await setup();
		const source = join(f.root, 'source');
		const prefix =
			form === 'root' || form === 'github-root'
				? ''
				: form === 'container'
					? 'apps/x/code/'
					: 'sub/folder/';
		const code = `${header}export default defineApp({description:'Source',actions:{}});\n`;
		await f.folder(
			source,
			{
				[`${prefix}epicenter.ts`]: code,
				[`${prefix}data/record.md`]: 'private',
				[`${prefix}node_modules/unused/x`]: 'dependency',
				[`${prefix}ui/dist/index.html`]: 'old build',
				[`${prefix}SOURCE.md`]: 'old provenance',
				[`${prefix}tool.sh`]: '#!/bin/sh\n',
			},
			{ git: true },
		);
		await gitIn(source, 'update-index', '--chmod=+x', `${prefix}tool.sh`);
		await gitIn(source, 'commit', '-qm', 'executable');
		await writeFile(
			join(source, prefix, 'epicenter.ts'),
			'uncommitted bad code',
		);
		github(f, 'owner/source', source);
		const from =
			form === 'github-root'
				? 'owner/source'
				: form === 'github-folder'
					? 'owner/source/sub/folder'
					: form === 'root'
						? source
						: join(source, form === 'container' ? 'apps/x' : 'sub/folder');
		const local = !form.startsWith('github');
		if (local) {
			// A local source must be the commit it gives.
			expect((await f.run('new', 'copy', '--from', from)).code).toBe(2);
			await gitIn(source, 'checkout', '-q', '--', '.');
		}
		const result = await f.run('new', 'copy', '--from', from, '--json');
		expect(result).toMatchObject({ code: 0 });
		const commit = await gitIn(source, 'rev-parse', 'HEAD');
		expect(JSON.parse(result.stdout).data.source).toEqual({ commit });
		const dest = join(f.apps, 'copy');
		expect(await readFile(join(dest, 'code/epicenter.ts'), 'utf8')).toBe(code);
		for (const path of [
			'code/data/record.md',
			'code/node_modules/unused/x',
			'code/ui/dist/index.html',
		])
			expect(await Bun.file(join(dest, path)).exists()).toBe(false);
		expect((await lstat(join(dest, 'code/tool.sh'))).mode & 0o111).not.toBe(0);
		expect(await readFile(join(dest, 'code/SOURCE.md'), 'utf8')).toContain(
			`Repository: ${local ? await realpath(source) : 'https://github.com/owner/source'}\nFolder: ${prefix.replace(/\/$/, '') || '.'}\nCommit: ${commit}\n`,
		);
		await noNestedGit(f.apps);
	});
}

test('a refreshed export is refused until its publication commit exists, and a later copy leaves the first app alone', async () => {
	const f = await setup();
	const sourceCode = (version: string) =>
		`${header}export default defineApp({description:'${version}',actions:{}});`;
	await f.folder(
		f.home,
		{ 'apps/writing/code/epicenter.ts': sourceCode('First version') },
		{ git: true },
	);
	const publication = join(f.root, 'publication');
	const output = join(publication, 'apps');
	expect((await f.run('export', '--all', output)).code).toBe(0);
	await gitIn(publication, 'init', '-q');
	await gitIn(publication, 'config', 'user.name', 'Publication Test');
	await gitIn(publication, 'config', 'user.email', 'publication@example.test');
	await gitIn(
		publication,
		'add',
		'--',
		'apps/writing/epicenter.ts',
		'apps/.epicenter-export.json',
	);
	await gitIn(publication, 'commit', '--no-verify', '-qm', 'first publication');
	const firstCommit = await gitIn(publication, 'rev-parse', 'HEAD');
	await writeFile(
		join(f.apps, 'writing/code/epicenter.ts'),
		sourceCode('Second version'),
	);
	await gitIn(f.home, 'add', '--', 'apps/writing/code/epicenter.ts');
	await gitIn(f.home, 'commit', '--no-verify', '-qm', 'second source version');
	expect((await f.run('export', '--all', output)).code).toBe(0);
	const from = join(output, 'writing');
	expect((await f.run('new', 'my-writing', '--from', from)).code).toBe(2);
	expect(existsSync(join(f.apps, 'my-writing'))).toBe(false);
	await gitIn(publication, 'stash', '-q');
	const first = await f.run('new', 'my-writing', '--from', from, '--json');
	expect(first.code).toBe(0);
	expect(JSON.parse(first.stdout).data.source).toEqual({ commit: firstCommit });
	expect(
		await readFile(join(f.apps, 'my-writing/code/epicenter.ts'), 'utf8'),
	).toBe(sourceCode('First version'));
	await writeFile(join(f.apps, 'my-writing/data/keep.md'), 'My own note');
	await gitIn(publication, 'stash', 'pop', '-q');
	await gitIn(publication, 'add', '--', 'apps/writing/epicenter.ts');
	await gitIn(
		publication,
		'commit',
		'--no-verify',
		'-qm',
		'second publication',
	);
	expect((await f.run('new', 'my-writing', '--from', from)).code).toBe(2);
	const second = await f.run('new', 'another-copy', '--from', from, '--json');
	expect(second.code).toBe(0);
	expect(
		await readFile(join(f.apps, 'another-copy/code/epicenter.ts'), 'utf8'),
	).toBe(sourceCode('Second version'));
	expect(await readFile(join(f.apps, 'my-writing/data/keep.md'), 'utf8')).toBe(
		'My own note',
	);
});

test('a local source with uncommitted code is refused and nothing is kept; ignored files, its records and changes outside it are not', async () => {
	const f = await setup();
	const source = join(f.root, 'source');
	const prefix = 'apps/original/code';
	await f.folder(
		source,
		{
			[`${prefix}/epicenter.ts`]: `${header}export default defineApp({description:'Source',actions:{}});`,
			[`${prefix}/kept.ts`]: 'original',
			[`${prefix}/.gitignore`]: 'ignored.txt\n',
			'apps/original/data/record.md': 'committed record',
			'README.md': 'outside selected code',
		},
		{ git: true },
	);
	const from = join(source, 'apps/original');
	const restore = () => gitIn(source, 'checkout', '-q', '--', '.');
	for (const change of [
		() => writeFile(join(source, prefix, 'kept.ts'), 'edited'),
		async () => {
			await writeFile(join(source, prefix, 'kept.ts'), 'staged');
			await gitIn(source, 'add', '--', `${prefix}/kept.ts`);
		},
		() => rm(join(source, prefix, 'kept.ts')),
		() => writeFile(join(source, prefix, 'new file\n雪.ts'), 'untracked'),
	]) {
		await change();
		const refused = await f.run('new', 'copy', '--from', from, '--json');
		expect(refused.code).toBe(2);
		expect(JSON.parse(refused.stdout).error.message).toBe(
			`${from} has uncommitted changes; commit them, then copy.`,
		);
		expect(existsSync(join(f.apps, 'copy'))).toBe(false);
		await gitIn(source, 'reset', '-q');
		await restore();
		await rm(join(source, prefix, 'new file\n雪.ts'), { force: true });
	}
	await writeFile(join(source, prefix, 'ignored.txt'), 'ignored file');
	await writeFile(join(source, 'README.md'), 'changed outside code');
	// A live app's records change all the time; the copy takes only code/.
	await writeFile(join(source, 'apps/original/data/record.md'), 'edited');
	await writeFile(join(source, 'apps/original/data/new.md'), 'untracked');
	const copied = await f.run('new', 'copy', '--from', from, '--json');
	expect(copied.code).toBe(0);
	expect(JSON.parse(copied.stdout).data.source).toEqual({
		commit: await gitIn(source, 'rev-parse', 'HEAD'),
	});
});

test('a copied link stays a link exactly as stored', async () => {
	const f = await setup();
	const source = join(f.root, 'source');
	const prefix = 'apps/x/code';
	await f.folder(source, {
		[`${prefix}/epicenter.ts`]: `${header}export default defineApp({description:'Theme',actions:{}});`,
		'theme.css': 'body { color: rgb(12, 34, 56); }',
	});
	await mkdir(join(source, prefix, 'ui/src'), { recursive: true });
	await symlink(
		'../../../../../theme.css',
		join(source, prefix, 'ui/src/theme.css'),
	);
	await gitIn(source, 'init', '-q');
	await gitIn(source, 'add', '.');
	await gitIn(source, 'commit', '-qm', 'theme');
	const result = await f.run(
		'new',
		'copy',
		'--from',
		join(source, 'apps/x'),
		'--json',
	);
	expect(result.code).toBe(0);
	expect(await readlink(join(f.apps, 'copy/code/ui/src/theme.css'))).toBe(
		'../../../../../theme.css',
	);
	expect(JSON.parse(result.stdout).data.links).toBeUndefined();
	await noNestedGit(f.apps);
});

test('copy failure removes only the created container and reports the source folder hint', async () => {
	const f = await setup();
	const source = await f.folder(
		join(f.root, 'source'),
		{ 'note.md': 'no app' },
		{ git: true },
	);
	const failed = await f.run('new', 'copy', '--from', source, '--json');
	expect(failed.code).toBe(2);
	expect(failed.stdout).toContain(
		"has no epicenter.ts that Git tracks; name the app's folder",
	);
	expect(await Bun.file(join(f.apps, 'copy')).exists()).toBe(false);
});

test('a folder holding several apps lists them and names one', async () => {
	const f = await setup();
	const app = (description: string) =>
		`${header}export default defineApp({description:'${description}',actions:{}});`;
	const source = await f.folder(
		join(f.root, 'shared'),
		{
			'examples/writing/epicenter.ts': app('Writing'),
			'examples/tasks/code/epicenter.ts': app('Tasks'),
			'examples/notes.md': 'not an app',
		},
		{ git: true },
	);
	const local = await f.run('new', 'copy', '--from', join(source, 'examples'));
	expect(local.code).toBe(2);
	expect(local.stderr).toContain(
		`holds 2 apps: tasks, writing. Run: epicenter new copy --from ${join(await realpath(source), 'examples/tasks')}`,
	);
	await gitIn(source, 'tag', 'v1');
	github(f, 'owner/shared', source);
	const remote = await f.run(
		'new',
		'copy',
		'--from',
		'owner/shared/examples#v1',
	);
	expect(remote.code).toBe(2);
	expect(remote.stderr).toContain(
		'Run: epicenter new copy --from owner/shared/examples/tasks#v1',
	);
	expect(await Bun.file(join(f.apps, 'copy')).exists()).toBe(false);
});

test('a GitHub folder is copied at a branch, a tag, or a full commit', async () => {
	const f = await setup();
	const app = (description: string) =>
		`${header}export default defineApp({description:'${description}',actions:{}});`;
	const source = await f.folder(
		join(f.root, 'versions'),
		{ 'apps/journal/epicenter.ts': app('First') },
		{ git: true },
	);
	const first = await gitIn(source, 'rev-parse', 'HEAD');
	await gitIn(source, 'tag', 'v1');
	await gitIn(source, 'checkout', '-qb', 'feature/second');
	await writeFile(join(source, 'apps/journal/epicenter.ts'), app('Second'));
	await gitIn(source, 'commit', '-qam', 'second');
	const second = await gitIn(source, 'rev-parse', 'HEAD');
	await gitIn(source, 'checkout', '-q', '-');
	github(f, 'owner/versions', source);
	for (const [name, ref, commit] of [
		['tagged', 'v1', first],
		['branched', 'feature/second', second],
		['pinned', first, first],
	] as const) {
		const made = await f.run(
			'new',
			name,
			'--from',
			`owner/versions/apps/journal#${ref}`,
			'--json',
		);
		expect(made.code).toBe(0);
		expect(JSON.parse(made.stdout).data.source).toEqual({ commit });
		expect(
			await readFile(join(f.apps, name, 'code/SOURCE.md'), 'utf8'),
		).toContain(`Folder: apps/journal\nRef: ${ref}\nCommit: ${commit}\n`);
	}
});

test('--from refuses addresses that are neither a path nor a GitHub folder', async () => {
	const f = await setup();
	for (const [from, hint] of [
		[
			'https://gitlab.com/someone/apps.git',
			'clone https://gitlab.com/someone/apps.git with git clone',
		],
		['git@github.com:someone/apps.git', 'with git clone'],
		['writing', 'write a folder on disk as ./writing'],
		['owner/repo/../escape', 'without ..'],
		['owner/repo#', 'names no ref after #'],
	] as const) {
		const refused = await f.run('new', 'copy', '--from', from);
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain(hint);
	}
});

test('new --from keeps folder pathspecs literal and filenames with tabs and newlines intact', async () => {
	const f = await setup();
	const source = join(f.root, 'source');
	const prefix = 'apps [copy]';
	const asset = 'asset\twith\nlines.bin';
	const bytes = new Uint8Array([0, 255, 128, 10]);
	await f.folder(source, {
		[`${prefix}/epicenter.ts`]: `${header}export default defineApp({description:'Literal paths',actions:{}});`,
		'apps c/epicenter.ts': 'throw new Error("wrong subtree");',
	});
	await writeFile(join(source, prefix, asset), bytes);
	await gitIn(source, 'init', '-q');
	await gitIn(source, 'add', '--', prefix, 'apps c');
	await gitIn(source, 'commit', '--no-verify', '-qm', 'literal path fixture');
	const run = await f.run(
		'new',
		'copy',
		'--from',
		join(source, prefix),
		'--json',
	);
	expect(run.code).toBe(0);
	expect(
		new Uint8Array(await readFile(join(f.apps, 'copy/code', asset))),
	).toEqual(bytes);
	expect((await f.run('copy', '--json')).code).toBe(0);
});

test('new --from descends into a code container and preserves a linked declaration', async () => {
	const f = await setup();
	const source = join(f.root, 'source');
	const prefix = 'apps/original/code';
	await f.folder(source, {
		[`${prefix}/app.ts`]: `${header}export default defineApp({description:'Linked declaration',actions:{}});`,
	});
	await symlink('app.ts', join(source, prefix, 'epicenter.ts'));
	await gitIn(source, 'init', '-q');
	await gitIn(source, 'add', '--', 'apps/original');
	await gitIn(
		source,
		'commit',
		'--no-verify',
		'-qm',
		'linked declaration fixture',
	);
	const run = await f.run(
		'new',
		'copy',
		'--from',
		join(source, 'apps/original'),
		'--json',
	);
	expect(run.code).toBe(0);
	expect(await readlink(join(f.apps, 'copy/code/epicenter.ts'))).toBe('app.ts');
	expect((await f.run('copy', '--json')).code).toBe(0);
});

test('copied LFS bytes retain inherited attributes under apps/name/code', async () => {
	const f = await setup();
	const source = join(f.root, 'lfs-source');
	await f.folder(source, {
		'.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
		'starter/epicenter.ts': `${header}export default defineApp({description:'LFS',actions:{}});`,
		'starter/image.bin': 'binary fixture bytes',
	});
	await gitIn(source, 'init', '-q');
	await gitIn(source, 'lfs', 'install', '--local');
	await gitIn(source, 'add', '.');
	await gitIn(source, 'commit', '-qm', 'lfs fixture');
	await gitIn(f.home, 'init', '-q');
	const result = await f.run(
		'new',
		'copy',
		'--from',
		join(source, 'starter'),
		'--json',
	);
	expect(result.code).toBe(0);
	const copied = join(f.apps, 'copy/code');
	expect(await readFile(join(copied, 'image.bin'), 'utf8')).toBe(
		'binary fixture bytes',
	);
	expect(
		await gitIn(
			f.home,
			'check-attr',
			'filter',
			'--',
			'apps/copy/code/image.bin',
		),
	).toBe('apps/copy/code/image.bin: filter: lfs');
	expect(await readFile(join(copied, '.gitattributes'), 'utf8')).toContain(
		'filter=lfs',
	);
	await noNestedGit(f.apps);
});

test('new --from makes the copy a package of this home: named for the new app, without its lock or its own @epicenter/app', async () => {
	const f = await setup();
	// An app of this home with a lock of its own, as an older home kept one. A
	// second package named `notes` would stop the install.
	await f.folder(
		f.home,
		{
			'apps/notes/code/epicenter.ts': `${header}export default defineApp({description:'Notes',actions:{}});\n`,
			'apps/notes/code/package.json': `${JSON.stringify(
				{
					name: 'notes',
					private: true,
					scripts: { test: 'bun test' },
				},
				null,
				'\t',
			)}\n`,
			'apps/notes/code/bun.lock': '{ "lockfileVersion": 1 }\n',
			'.gitignore': 'node_modules/\n',
		},
		{ git: true },
	);
	const made = await f.run(
		'new',
		'journal',
		'--from',
		join(f.apps, 'notes'),
		'--json',
	);
	expect(made).toMatchObject({ code: 0 });
	const code = join(f.apps, 'journal/code');
	// Only the name changed; the rest reads as it did.
	expect(await readFile(join(code, 'package.json'), 'utf8')).toBe(
		`${JSON.stringify({ name: 'journal', private: true, scripts: { test: 'bun test' } }, null, '\t')}\n`,
	);
	expect(existsSync(join(code, 'bun.lock'))).toBe(false);
	// Renamed, the copy installs beside the app it came from.
	const install = Bun.spawn([process.execPath, 'install'], {
		cwd: f.home,
		stdout: 'ignore',
		stderr: 'ignore',
	});
	expect(await install.exited).toBe(0);
	expect(await readFile(join(f.home, 'bun.lock'), 'utf8')).toContain(
		'"apps/journal/code"',
	);
	const listed = JSON.parse((await f.run('--json')).stdout).data;
	expect(listed.apps.map((app: { name: string }) => app.name)).toEqual([
		'journal',
		'notes',
	]);

	// From elsewhere: an app that listed the library itself, and one with no
	// package.json, which gets the one blank code has.
	const source = await f.folder(
		join(f.root, 'source'),
		{
			'old/epicenter.ts': `${header}export default defineApp({description:'Old',actions:{}});\n`,
			'old/package.json': JSON.stringify({
				name: 'old-name',
				dependencies: { '@epicenter/app': '0.1.0' },
			}),
			'bare/epicenter.ts': `${header}export default defineApp({description:'Bare',actions:{}});\n`,
		},
		{ git: true },
	);
	for (const app of ['old', 'bare']) {
		const from = join(source, app);
		expect((await f.run('new', app, '--from', from)).code).toBe(0);
	}
	expect(await Bun.file(join(f.apps, 'old/code/package.json')).json()).toEqual({
		name: 'old',
	});
	expect(await Bun.file(join(f.apps, 'bare/code/package.json')).json()).toEqual(
		{ name: 'bare', private: true },
	);
});
