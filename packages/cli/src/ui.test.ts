/**
 * View build tests: `epicenter build` builds an app's view from its code's
 * `HEAD` into `ui/dist/`, never from the working tree, and a failed build
 * leaves the last view in place. `serve`'s rebuilding is in
 * `acceptance.http.test.ts`.
 */
import { afterEach, expect, test } from 'bun:test';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, gitIn, gitignore, header } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** A `ui/package.json` whose `build` runs `script`, with no dependency to install. */
function uiPackage(script: string) {
	return `${JSON.stringify({ name: 'ui', private: true, scripts: { build: script } })}\n`;
}
const writes = (label: string) =>
	uiPackage(`mkdir -p dist && echo ${label} > dist/index.html`);

/** A committed app `vocab` whose `ui/` holds `files`. */
async function vocab(files: Record<string, string>) {
	const f = await fixture();
	roots.push(f.root);
	const app = await f.folder(join(f.home, 'vocab'), {
		'.gitignore': `${gitignore}ui/dist/\n`,
		'epicenter.ts': `${header}export default defineApp({ description: 'Words', collections: {}, actions: {} });\n`,
		...Object.fromEntries(
			Object.entries(files).map(([path, text]) => [`ui/${path}`, text]),
		),
	});
	const view = () => readFile(join(app, 'ui', 'dist', 'index.html'), 'utf8');
	const commit = async (path: string, text: string, message: string) => {
		await writeFile(join(app, 'ui', path), text);
		await gitIn(app, 'add', '--', `ui/${path}`);
		await gitIn(app, 'commit', '-q', '--no-verify', '-m', message);
	};
	return { ...f, app, view, commit };
}

test('build builds the last commit, not the working tree, and leaves nothing behind', async () => {
	const f = await vocab({ 'package.json': writes('one') });
	await writeFile(join(f.app, 'ui', 'package.json'), writes('uncommitted'));
	const built = await f.run('build', 'vocab');
	expect(built.stderr).toBe('');
	const head = await gitIn(f.app, 'rev-parse', 'HEAD');
	expect(built.stdout).toBe(`vocab: view built from ${head.slice(0, 7)}\n`);
	expect(await f.view()).toBe('one\n');
	expect(
		await readFile(join(f.app, 'ui', 'dist', '.epicenter-build'), 'utf8'),
	).toStartWith(`${head}\n`);
	expect(await gitIn(f.app, 'status', '--porcelain')).toBe('M ui/package.json');
	expect(await gitIn(f.app, 'worktree', 'list', '--porcelain')).not.toContain(
		'detached',
	);
	expect(
		(await readdir(f.home)).filter((name) => name.startsWith('.')),
	).toEqual([]);
});

test('a build script is told the path its view is served at', async () => {
	const f = await vocab({
		'package.json': uiPackage(
			'mkdir -p dist && echo "$EPICENTER_BASE" > dist/index.html',
		),
	});
	expect((await f.run('build', 'vocab')).code).toBe(0);
	expect(await f.view()).toBe('/vocab\n');
});

test('a ui/ with no build script is bundled from its index.html, with relative paths', async () => {
	const f = await vocab({
		'index.html':
			'<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>\n',
		'main.ts':
			"import { connect } from '@epicenter/app/client';\ndocument.body.dataset.client = typeof connect;\n",
	});
	const built = await f.run('build', 'vocab');
	expect(built.stderr).toBe('');
	const html = await f.view();
	expect(html).toMatch(/src="\.\/[^"]+\.js"/);
	expect(html).not.toContain('main.ts');
});

test('a failed build keeps the last view and says why', async () => {
	const f = await vocab({ 'package.json': writes('one') });
	expect((await f.run('build', 'vocab')).code).toBe(0);
	await f.commit('package.json', uiPackage('exit 7'), 'break the build');
	const failed = await f.run('build', 'vocab');
	expect(failed.code).toBe(1);
	expect(failed.stderr).toContain('exited 7');
	expect(await f.view()).toBe('one\n');

	await f.commit('package.json', uiPackage('true'), 'write nothing');
	const empty = await f.run('build', 'vocab');
	expect(empty.code).toBe(1);
	expect(empty.stderr).toContain('ui/dist/index.html');
	expect(await f.view()).toBe('one\n');
});

test('an app whose last commit has no view source has nothing to build', async () => {
	const f = await vocab({});
	const built = await f.run('build', 'vocab', '--json');
	expect(built.code).toBe(0);
	expect(JSON.parse(built.stdout).apps).toEqual([
		{ app: 'vocab', folder: f.app, built: null },
	]);
});
