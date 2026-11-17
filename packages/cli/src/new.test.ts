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
import { fixture, gitIn, header, startServe } from './runner.test-support.ts';

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

test('new shows how to open a browser app on the home port', async () => {
	const f = await setup();
	const source = await f.folder(
		join(f.root, 'source'),
		{
			'epicenter.ts': `${header}export default defineApp({description:'Garden',actions:{}});`,
			'ui/index.html': '<h1>Garden</h1>',
		},
		{ git: true },
	);
	await writeFile(join(f.home, 'EPICENTER.md'), '---\nport: 4861\n---\n');
	const made = await f.run('new', 'garden', '--from', source);
	expect(made.code).toBe(0);
	expect(made.stderr).toBe(
		'Run: epicenter serve\nOpen http://127.0.0.1:4861/garden/ in your browser.\n',
	);
});

test('new creates code and empty data without repositories and refuses taken and reserved names', async () => {
	const f = await setup();
	await gitIn(f.home, 'init', '-q');
	await mkdir(join(f.apps, 'Reading'));
	for (const name of ['reading', 'serve', 'init', 'build', 'Bad_Name'])
		expect((await f.run('new', name, '--json')).code).toBe(2);
	const made = await f.run('new', 'garden', '--json');
	expect(made.code).toBe(0);
	const container = join(f.apps, 'garden');
	expect(JSON.parse(made.stdout)).toEqual({
		name: 'garden',
		folder: container,
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
	expect(await readFile(join(f.home, 'bun.lock'), 'utf8')).toContain(
		'"apps/garden/code"',
	);
	expect((await f.run('garden', '--json')).code).toBe(0);
	expect((await f.run('build', 'garden')).code).toBe(0);
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
		const result = await f.run('new', 'copy', '--from', from, '--json');
		expect(result).toMatchObject({ code: 0 });
		const commit = await gitIn(source, 'rev-parse', 'HEAD');
		expect(JSON.parse(result.stdout).source).toEqual(
			local ? { commit, notCopied: ['epicenter.ts', 'tool.sh'] } : { commit },
		);
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
		expect((await f.run('build', 'copy')).code).toBe(0);
		await noNestedGit(f.apps);
	});
}

test('a refreshed export warns until its publication commit exists, and a later copy leaves the first app alone', async () => {
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
	const first = await f.run('new', 'my-writing', '--from', from, '--json');
	expect(first.code).toBe(0);
	expect(JSON.parse(first.stdout).source).toEqual({
		commit: firstCommit,
		notCopied: ['epicenter.ts'],
	});
	expect(
		await readFile(join(f.apps, 'my-writing/code/epicenter.ts'), 'utf8'),
	).toBe(sourceCode('First version'));
	await writeFile(join(f.apps, 'my-writing/data/keep.md'), 'My own note');
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
	expect(JSON.parse(second.stdout).source.notCopied).toEqual([]);
	expect(
		await readFile(join(f.apps, 'another-copy/code/epicenter.ts'), 'utf8'),
	).toBe(sourceCode('Second version'));
	expect(await readFile(join(f.apps, 'my-writing/data/keep.md'), 'utf8')).toBe(
		'My own note',
	);
});

test('source warnings include staged, deleted, and untracked code while excluding records and generated files', async () => {
	const f = await setup();
	const source = join(f.root, 'source');
	const prefix = 'apps/original/code';
	const code = `${header}export default defineApp({description:'Source',actions:{}});`;
	await f.folder(
		source,
		{
			[`${prefix}/epicenter.ts`]: code,
			[`${prefix}/staged.ts`]: 'original',
			[`${prefix}/deleted.ts`]: 'original',
			[`${prefix}/.gitignore`]: 'ignored.txt\n',
			[`${prefix}/data/record.md`]: 'private',
			[`${prefix}/node_modules/unused/index.js`]: 'dependency',
			[`${prefix}/ui/dist/index.html`]: 'old build',
			[`${prefix}/SOURCE.md`]: 'old provenance',
			'README.md': 'outside selected code',
		},
		{ git: true },
	);
	await writeFile(join(source, prefix, 'staged.ts'), 'staged change');
	await gitIn(source, 'add', '--', `${prefix}/staged.ts`);
	await writeFile(join(source, prefix, 'staged.ts'), 'original');
	await rm(join(source, prefix, 'deleted.ts'));
	await writeFile(join(source, prefix, 'new file\n雪.ts'), 'untracked code');
	await writeFile(join(source, prefix, 'ignored.txt'), 'ignored file');
	for (const path of [
		'data/record.md',
		'node_modules/unused/index.js',
		'ui/dist/index.html',
		'SOURCE.md',
	])
		await writeFile(join(source, prefix, path), 'changed excluded content');
	await writeFile(join(source, 'README.md'), 'changed outside code');
	const from = join(source, 'apps/original');
	const result = await f.run('new', 'copy', '--from', from, '--json');
	expect(result.code).toBe(0);
	expect(result.stderr).toBe('');
	expect(JSON.parse(result.stdout).source.notCopied).toEqual([
		'deleted.ts',
		'new file\n雪.ts',
		'staged.ts',
	]);
	const text = await f.run('new', 'second-copy', '--from', from);
	expect(text.code).toBe(0);
	expect(text.stderr).toContain(
		`copied source commit ${await gitIn(source, 'rev-parse', 'HEAD')}`,
	);
	expect(text.stderr).toContain(
		'3 source file(s) differ from it and were not copied',
	);
	expect(text.stderr).toContain('"new file\\n雪.ts"');
});

test('excluded changes do not warn and a GitHub folder has no working tree report', async () => {
	const f = await setup();
	const source = join(f.root, 'source');
	await f.folder(
		source,
		{
			'epicenter.ts': `${header}export default defineApp({description:'Source',actions:{}});`,
			'.gitignore': 'ignored.txt\n',
			'data/private.md': 'private',
		},
		{ git: true },
	);
	await writeFile(join(source, 'data/private.md'), 'changed private data');
	await writeFile(join(source, 'ignored.txt'), 'ignored file');
	const clean = await f.run('new', 'clean', '--from', source, '--json');
	expect(clean.code).toBe(0);
	expect(JSON.parse(clean.stdout).source.notCopied).toEqual([]);
	const bare = join(f.root, 'source.git');
	await gitIn(f.root, 'clone', '--bare', source, bare);
	github(f, 'owner/bare', bare);
	const remote = await f.run(
		'new',
		'from-bare',
		'--from',
		'owner/bare',
		'--json',
	);
	expect(remote.code).toBe(0);
	expect(JSON.parse(remote.stdout).source).toEqual({
		commit: await gitIn(source, 'rev-parse', 'HEAD'),
	});
});

test('a source commit made after cloning is reported against the commit actually copied', async () => {
	const f = await setup();
	const source = await f.folder(
		join(f.root, 'source'),
		{
			'epicenter.ts': `${header}export default defineApp({description:'Source',actions:{}});`,
		},
		{ git: true },
	);
	const copiedCommit = await gitIn(source, 'rev-parse', 'HEAD');
	const realGit = Bun.which('git');
	if (!realGit) throw new Error('Git is required for this test');
	const wrapper = join(f.root, 'bin');
	await mkdir(wrapper);
	await writeFile(
		join(wrapper, 'git'),
		`#!/bin/sh
"$EPICENTER_TEST_GIT" "$@" || exit "$?"
for word do
  if [ "$word" = clone ]; then
    printf '%s\\n' 'new committed code' > "$EPICENTER_TEST_SOURCE/added.ts"
    "$EPICENTER_TEST_GIT" -C "$EPICENTER_TEST_SOURCE" add -- added.ts
    "$EPICENTER_TEST_GIT" -C "$EPICENTER_TEST_SOURCE" -c commit.gpgsign=false commit --no-verify -qm 'advance source after clone'
    break
  fi
done
`,
		{ mode: 0o755 },
	);
	f.env.PATH = `${wrapper}:${process.env.PATH}`;
	f.env.EPICENTER_TEST_GIT = realGit;
	f.env.EPICENTER_TEST_SOURCE = source;
	const result = await f.run('new', 'copy', '--from', source, '--json');
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout).source).toEqual({
		commit: copiedCommit,
		notCopied: ['added.ts'],
	});
	expect(await gitIn(source, 'status', '--porcelain')).toBe('');
	expect(await Bun.file(join(f.apps, 'copy/code/added.ts')).exists()).toBe(
		false,
	);
});

for (const hasTheme of [true, false]) {
	test(`copied external theme symlink stays a link and ${hasTheme ? 'builds with a root theme' : 'reports a missing root theme'}`, async () => {
		const f = await setup();
		const source = join(f.root, 'source');
		const prefix = 'apps/x/code';
		await f.folder(source, {
			[`${prefix}/epicenter.ts`]: `${header}export default defineApp({description:'Theme',actions:{}});`,
			[`${prefix}/ui/index.html`]:
				'<html><head><link rel="stylesheet" href="./src/theme.css"></head><body>Theme</body></html>',
			'theme.css': 'body { color: rgb(12, 34, 56); }',
		});
		await mkdir(join(source, prefix, 'ui/src'));
		await symlink(
			'../../../../../theme.css',
			join(source, prefix, 'ui/src/theme.css'),
		);
		await gitIn(source, 'init', '-q');
		await gitIn(source, 'add', '.');
		await gitIn(source, 'commit', '-qm', 'theme');
		if (hasTheme)
			await writeFile(
				join(f.home, 'theme.css'),
				'body { color: rgb(12, 34, 56); }',
			);
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
		if (!hasTheme) {
			expect(JSON.parse(result.stdout).links).toEqual([
				{ path: 'ui/src/theme.css', target: '../../../../../theme.css' },
			]);
			expect(result.stderr).toContain(
				'copy: code/ui/src/theme.css links to ../../../../../theme.css, which this Epicenter does not have',
			);
		} else {
			expect((await f.run('build', 'copy')).code).toBe(0);
			const { readdir } = await import('node:fs/promises');
			const dist = join(f.apps, 'copy/code/ui/dist');
			expect(await Bun.file(join(dist, 'index.html')).exists()).toBe(true);
			const css = (await readdir(dist)).filter((path) => path.endsWith('.css'));
			expect(css.length).toBeGreaterThan(0);
			expect(await readFile(join(dist, css[0]!), 'utf8')).toContain('#0c2238');
			await noNestedGit(f.apps);
			const served = await startServe(f);
			try {
				expect((await fetch(`${served.base}/copy/`)).status).toBe(200);
			} finally {
				await served.stop();
			}
		}
		await noNestedGit(f.apps);
	});
}

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
		expect(JSON.parse(made.stdout).source).toEqual({ commit });
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
	const lock = await readFile(join(f.home, 'bun.lock'), 'utf8');
	expect(lock).toContain('"apps/journal/code"');
	const listed = JSON.parse((await f.run('--json')).stdout);
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
