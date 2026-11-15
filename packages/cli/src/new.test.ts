/** New apps use code/data containers; source copies preserve committed modes and links while excluding records and caches. */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
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

async function noNestedGit(folder: string): Promise<void> {
	const { readdir } = await import('node:fs/promises');
	for (const entry of await readdir(folder, { withFileTypes: true })) {
		expect(entry.name).not.toBe('.git');
		if (entry.isDirectory()) await noNestedGit(join(folder, entry.name));
	}
}

test('new creates code and empty data without repositories and refuses taken and reserved names', async () => {
	const f = await setup();
	await gitIn(f.home, 'init', '-q');
	await mkdir(join(f.apps, 'Reading'));
	for (const name of [
		'reading',
		'serve',
		'checkpoint',
		'init',
		'build',
		'Bad_Name',
	])
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
	expect(
		await realpath(join(container, 'code/node_modules/@epicenter/app')),
	).toBe(await realpath(join(import.meta.dir, '../../app')));
	expect(
		await lstat(join(container, 'node_modules')).catch(() => undefined),
	).toBeUndefined();
	expect((await f.run('install', 'garden')).code).toBe(0);
	expect((await f.run('build', 'garden')).code).toBe(0);
	await noNestedGit(f.apps);
});

for (const form of [
	'root',
	'url-root',
	'url-folder',
	'local-folder',
	'container',
] as const) {
	test(`new --from copies committed code from ${form}, excludes records and caches, and records provenance`, async () => {
		const f = await setup();
		const source = join(f.root, 'source');
		const prefix =
			form === 'root' || form === 'url-root'
				? ''
				: form === 'container'
					? 'apps/x/code/'
					: 'sub/folder/';
		const code = `${header}export default defineApp({description:'Source',collections:{},actions:{}});\n`;
		await f.folder(
			source,
			{
				[`${prefix}epicenter.ts`]: code,
				[`${prefix}data/record.md`]: 'private',
				[`${prefix}key.local`]: 'private',
				[`${prefix}key.local.json`]: 'private',
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
		const from =
			form === 'url-root'
				? `file://${source}`
				: form === 'root'
					? source
					: form === 'local-folder'
						? join(source, 'sub/folder')
						: `file://${source}#${form === 'container' ? 'apps/x' : 'sub/folder'}`;
		const result = await f.run('new', 'copy', '--from', from, '--json');
		expect(result).toMatchObject({ code: 0 });
		const dest = join(f.apps, 'copy');
		expect(await readFile(join(dest, 'code/epicenter.ts'), 'utf8')).toBe(code);
		for (const path of [
			'code/data/record.md',
			'code/key.local',
			'code/key.local.json',
			'code/node_modules/unused/x',
			'code/ui/dist/index.html',
		])
			expect(await Bun.file(join(dest, path)).exists()).toBe(false);
		expect((await lstat(join(dest, 'code/tool.sh'))).mode & 0o111).not.toBe(0);
		expect(await readFile(join(dest, 'code/SOURCE.md'), 'utf8')).toContain(
			`Source: ${from}\nSource-Commit:`,
		);
		expect((await f.run('install', 'copy')).code).toBe(0);
		expect((await f.run('build', 'copy')).code).toBe(0);
		await noNestedGit(f.apps);
	});
}

for (const hasTheme of [true, false]) {
	test(`copied external theme symlink stays a link and ${hasTheme ? 'builds with a root theme' : 'reports a missing root theme'}`, async () => {
		const f = await setup();
		const source = join(f.root, 'source');
		const prefix = 'apps/x/code';
		await f.folder(source, {
			[`${prefix}/epicenter.ts`]: `${header}export default defineApp({description:'Theme',collections:{},actions:{}});`,
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
			`file://${source}#apps/x`,
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
	expect(failed.stdout).toContain('#<folder>');
	expect(await Bun.file(join(f.apps, 'copy')).exists()).toBe(false);
});

test('copied LFS bytes retain inherited attributes under apps/name/code', async () => {
	const f = await setup();
	const source = join(f.root, 'lfs-source');
	await f.folder(source, {
		'.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n',
		'starter/epicenter.ts': `${header}export default defineApp({description:'LFS',collections:{},actions:{}});`,
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
