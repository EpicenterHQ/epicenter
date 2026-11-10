import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, gitIn, readingApp } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

const trailer = (folder: string, key: string) =>
	gitIn(folder, 'log', '-1', `--format=%(trailers:key=${key},valueonly)`);

test('install makes the app and commits its code and view with its source', async () => {
	const f = await fixture();
	roots.push(f.root);
	const source = await f.folder(join(f.root, 'code', 'reading'), {
		'epicenter.json': readingApp['epicenter.json'],
		'epicenter.ts': readingApp['epicenter.ts'],
		'view/index.html': '<h1>Reading</h1>\n',
	});

	const installed = await f.run('install', source, '--json');
	expect(installed.code).toBe(0);
	const app = join(f.home, 'reading');
	expect(JSON.parse(installed.stdout)).toEqual({
		name: 'reading',
		folder: app,
	});
	expect(await gitIn(app, 'log', '--format=%s')).toBe(
		'install reading\nnew reading',
	);
	expect(await trailer(app, 'Source')).toBe(source);
	expect(await trailer(app, 'Source-Commit')).toBe(
		await gitIn(source, 'rev-parse', '--short', 'HEAD'),
	);
	expect(await readFile(join(app, 'view', 'index.html'), 'utf8')).toBe(
		'<h1>Reading</h1>\n',
	);
	expect(await gitIn(app, 'ls-files')).toBe(
		'.gitignore\nepicenter.json\nepicenter.ts\nview/index.html',
	);
	expect(await gitIn(app, 'status', '--porcelain')).toBe('');

	// The installed app runs.
	expect((await f.run('reading', 'log', '30')).code).toBe(0);
});

test('install <app> installs again from the recorded source, overwriting an edit in place and keeping the data', async () => {
	const f = await fixture();
	roots.push(f.root);
	const source = await f.folder(join(f.root, 'code', 'reading'), {
		'epicenter.json': readingApp['epicenter.json'],
		'epicenter.ts': readingApp['epicenter.ts'],
		'view/index.html': '<h1>Reading</h1>\n',
	});
	expect((await f.run('install', source)).code).toBe(0);
	const app = join(f.home, 'reading');
	await writeFile(join(app, 'books.md'), 'data\n');
	await writeFile(join(app, 'epicenter.ts'), '// edited in place\n');
	await gitIn(app, 'add', '-A');
	await gitIn(app, 'commit', '-qm', 'by hand');

	await rm(join(source, 'epicenter.ts'));
	await rm(join(source, 'view'), { recursive: true });
	const again = await f.run('install', 'reading');
	expect(again.code).toBe(0);
	expect(existsSync(join(app, 'epicenter.ts'))).toBe(false);
	expect(existsSync(join(app, 'view'))).toBe(false);
	expect(await gitIn(app, 'status', '--porcelain')).toBe('');
	expect(await readFile(join(app, 'books.md'), 'utf8')).toBe('data\n');
	expect(await gitIn(app, 'log', '-1', '--format=%s')).toBe('install reading');
	expect(await trailer(app, 'Source-Commit')).toEndWith(
		'(with uncommitted changes)',
	);
	// The edit in place is still in history.
	expect(await gitIn(app, 'show', 'HEAD~1:epicenter.ts')).toBe(
		'// edited in place',
	);
});

test('install runs the source build with the mount path into .cache/view/, committing none of it', async () => {
	const f = await fixture();
	roots.push(f.root);
	const source = await f.folder(
		join(f.root, 'code', 'shelf'),
		{
			'epicenter.json': readingApp['epicenter.json'],
			'package.json': JSON.stringify({
				scripts: {
					build: 'mkdir -p build && printf "$VIEW_BASE" > build/index.html',
				},
			}),
			'node_modules/.keep': '',
		},
		{ git: false },
	);
	const installed = await f.run('install', source, 'books');
	expect(installed.stderr).toBe('Run: epicenter books\n');
	expect(installed.code).toBe(0);
	const books = join(f.home, 'books');
	expect(
		await readFile(join(books, '.cache', 'view', 'index.html'), 'utf8'),
	).toBe('/books');
	expect(await gitIn(books, 'ls-files')).toBe('.gitignore\nepicenter.json');
	expect(await gitIn(books, 'status', '--porcelain')).toBe('');
	expect(await trailer(books, 'Source-Commit')).toBe('');
});

test('install refuses a folder without epicenter.json, a name for a bare app, and an app with no recorded source', async () => {
	const f = await fixture();
	roots.push(f.root);
	const empty = await f.folder(join(f.root, 'empty'), { 'notes.md': 'x\n' });
	const cases = [
		['install', empty],
		['install', 'reading', 'other'],
		['install', 'missing'],
	];
	for (const words of cases) {
		const result = await f.run(...words, '--json');
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout).error.name).toBe('Usage');
	}
	expect((await f.run('new', 'install')).code).toBe(2);
});
