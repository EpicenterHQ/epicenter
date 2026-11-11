/**
 * Starter update tests: cloning, merging, and UI builds. Sync coverage
 * checks that an origin receives only home pushes.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, gitIn, gitignore, header } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** An app with one Markdown collection whose files need a `meaning`, and a `reading` when `reading` is required. */
function wordsApp({ reading }: { reading: 'required' | 'optional' }) {
	const field =
		reading === 'required' ? 'field.text()' : 'field.text({ optional: true })';
	return `${header}
const words = defineCollection({
	path: 'data/words/{word}.md',
	fields: { meaning: field.text(), reading: ${field} },
});

export default defineApp({
	description: 'Words I am learning',
	collections: { words },
	actions: { words: words.actions() },
});
`;
}

/** A `ui/` whose build writes `label` to `dist/index.html`, without a dependency to install. */
function uiPackage(build: string) {
	return `${JSON.stringify({ name: 'ui', private: true, scripts: { build } })}\n`;
}
const builds = (label: string) =>
	uiPackage(`mkdir -p dist && echo ${label} > dist/index.html`);

/** Commit every change in `dir` as `message`. */
async function commitAll(dir: string, message: string) {
	await gitIn(dir, 'add', '-A');
	await gitIn(dir, 'commit', '-q', '--no-verify', '-m', message);
}

async function starterFixture() {
	const f = await fixture();
	roots.push(f.root);
	const starter = await f.folder(join(f.root, 'starters', 'vocab'), {
		'.gitignore': gitignore,
		'epicenter.ts': wordsApp({ reading: 'optional' }),
		'ui/package.json': builds('one'),
		'ui/.gitignore': 'dist/\nnode_modules/\n',
	});
	return { ...f, starter, app: join(f.home, 'vocab') };
}

test('new --from clones a starter as upstream, tracking nothing, and builds its UI', async () => {
	const f = await starterFixture();
	const made = await f.run('new', 'vocab', '--from', f.starter, '--json');
	expect(made.code).toBe(0);
	expect(await gitIn(f.app, 'remote')).toBe('upstream');
	expect(
		await gitIn(f.app, 'config', '--get-regexp', '^branch\\.').catch(() => ''),
	).toBe('');
	expect(await readFile(join(f.app, 'ui', 'dist', 'index.html'), 'utf8')).toBe(
		'one\n',
	);
	expect(await gitIn(f.app, 'status', '--porcelain')).toBe('');

	const inside = await f.run(
		'new',
		'nested',
		'--from',
		join(f.starter, 'ui'),
		'--json',
	);
	expect(inside.code).toBe(2);
	expect(JSON.parse(inside.stdout).error.message).toContain(
		"is not a repository's root",
	);
	expect(existsSync(join(f.home, 'nested'))).toBe(false);
});

test('new --from refuses a starter whose epicenter.ts does not load, and leaves no folder', async () => {
	const f = await starterFixture();
	await writeFile(
		join(f.starter, 'epicenter.ts'),
		`${header}defineCollection({ path: 'data/words/', fields: {} });\n`,
	);
	await commitAll(f.starter, 'break the app');
	const made = await f.run('new', 'vocab', '--from', f.starter, '--json');
	expect(made.code).toBe(2);
	expect(JSON.parse(made.stdout).error).toMatchObject({
		name: 'AppProblems',
		problems: ['epicenter.ts: The collection path data/words/ is not a .md path'],
	});
	expect(existsSync(f.app)).toBe(false);
});

test('update merges the starter and builds; a file that no longer fits says so when read', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);
	expect(
		(await f.run('vocab', 'words', 'add', 'neko', '--meaning', 'cat')).code,
	).toBe(0);

	const quiet = JSON.parse((await f.run('update', 'vocab', '--json')).stdout);
	expect(quiet.apps[0]).toMatchObject({
		upstream: true,
		merged: null,
		built: true,
	});

	await writeFile(
		join(f.starter, 'epicenter.ts'),
		wordsApp({ reading: 'required' }),
	);
	await writeFile(join(f.starter, 'ui', 'package.json'), builds('two'));
	await commitAll(f.starter, 'require a reading');
	const updated = await f.run('update');
	expect(updated.code).toBe(0);
	expect(updated.stdout).toMatch(/^vocab: merged [0-9a-f]+; UI built\n$/);
	expect(await gitIn(f.app, 'log', '-1', '--format=%s')).toBe(
		'vocab: update from upstream',
	);
	expect(await readFile(join(f.app, 'ui', 'dist', 'index.html'), 'utf8')).toBe(
		'two\n',
	);
	expect(await gitIn(f.app, 'status', '--porcelain')).toBe('');
	const read = await f.run('vocab', 'words', 'get', 'data/words/neko.md', '--json');
	expect(JSON.parse(read.stdout).returned.problems).toEqual([
		'reading is missing',
	]);
});

test('update snapshots pending changes before it merges, and undoes a merge that conflicts', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);

	await mkdir(join(f.app, 'data'));
	await writeFile(join(f.app, 'data/notes.md'), 'unsaved\n');
	await writeFile(join(f.starter, 'README.md'), 'about vocab\n');
	await commitAll(f.starter, 'add a readme');
	const pending = await f.run('update', 'vocab');
	expect(pending.code).toBe(0);
	expect(await gitIn(f.app, 'log', '--first-parent', '-2', '--format=%s')).toBe(
		'vocab: update from upstream\nvocab: changed outside epicenter',
	);
	expect(await readFile(join(f.app, 'data/notes.md'), 'utf8')).toBe('unsaved\n');
	expect(await gitIn(f.app, 'status', '--porcelain')).toBe('');

	await writeFile(join(f.app, 'ui', 'package.json'), builds('mine'));
	await commitAll(f.app, 'my own UI');
	await writeFile(join(f.starter, 'ui', 'package.json'), builds('theirs'));
	await commitAll(f.starter, 'their UI');
	const head = await gitIn(f.app, 'rev-parse', 'HEAD');
	const clash = await f.run('update', 'vocab');
	expect(clash.code).toBe(1);
	expect(clash.stderr).toContain('the merge stopped on a conflict');
	expect(clash.stderr).toMatch(/Run: git -C .*vocab merge upstream\/\w+/);
	expect(await gitIn(f.app, 'rev-parse', 'HEAD')).toBe(head);
	expect(await gitIn(f.app, 'status', '--porcelain')).toBe('');
});

test('an app without a starter is left alone by update', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'garden')).code).toBe(0);
	const updated = await f.run('update');
	expect(updated.code).toBe(0);
	expect(updated.stdout).toBe('garden: no upstream; left alone\n');
});

test('a failed build keeps the last UI that built', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);
	await writeFile(join(f.starter, 'ui', 'package.json'), uiPackage('exit 7'));
	await commitAll(f.starter, 'break the build');
	const updated = await f.run('update', 'vocab');
	expect(updated.code).toBe(1);
	expect(updated.stderr).toContain('the last one that did is kept');
	expect(await readFile(join(f.app, 'ui', 'dist', 'index.html'), 'utf8')).toBe(
		'one\n',
	);
});

test('a build that removes its output keeps the last UI and names the required index', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);
	await writeFile(
		join(f.starter, 'ui', 'package.json'),
		uiPackage('rm -rf dist'),
	);
	await commitAll(f.starter, 'empty the build');
	const updated = await f.run('update', 'vocab');
	expect(updated.code).toBe(1);
	expect(updated.stderr).toContain('ui/dist/index.html');
	expect(await readFile(join(f.app, 'ui', 'dist', 'index.html'), 'utf8')).toBe(
		'one\n',
	);
});

test('sync pushes to origin, never to the starter', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);
	const starterHead = await gitIn(f.starter, 'rev-parse', 'HEAD');

	const alone = JSON.parse((await f.run('sync', 'vocab', '--json')).stdout);
	expect(alone.apps[0]).toMatchObject({ pushed: false, origin: null });

	const backup = join(f.root, 'backup.git');
	await gitIn(f.root, 'init', '-q', '--bare', backup);
	await gitIn(f.app, 'remote', 'add', 'origin', backup);
	expect(
		(await f.run('vocab', 'words', 'add', 'neko', '--meaning', 'cat')).code,
	).toBe(0);
	expect(JSON.parse((await f.run('vocab', '--json')).stdout).status).toEqual({
		pending: 0,
		backup: 'never',
	});
	const synced = await f.run('sync', 'vocab', '--json');
	expect(synced.code).toBe(0);
	expect(JSON.parse(synced.stdout).apps[0]).toMatchObject({
		pushed: true,
		origin: { ahead: 0 },
	});
	const branch = await gitIn(f.app, 'symbolic-ref', '--short', 'HEAD');
	expect(await gitIn(backup, 'rev-parse', branch)).toBe(
		await gitIn(f.app, 'rev-parse', 'HEAD'),
	);
	expect(await gitIn(f.starter, 'rev-parse', 'HEAD')).toBe(starterHead);
});

test('new --from whose UI does not build makes the app, exits 1, and names build', async () => {
	const f = await starterFixture();
	await writeFile(join(f.starter, 'ui', 'package.json'), uiPackage('exit 7'));
	await commitAll(f.starter, 'break the build');
	const made = await f.run('new', 'vocab', '--from', f.starter, '--json');
	expect(made.code).toBe(1);
	expect(JSON.parse(made.stdout)).toEqual({
		name: 'vocab',
		folder: f.app,
		error: {
			message: expect.stringContaining('vocab: the UI did not build: '),
			next: 'epicenter build vocab',
		},
	});
	expect(await gitIn(f.app, 'remote')).toBe('upstream');

	const human = await f.run('new', 'words', '--from', f.starter);
	expect(human.code).toBe(1);
	expect(human.stdout).toBe(`${join(f.home, 'words')}\n`);
	expect(human.stderr).toStartWith('words: the UI did not build: ');
	expect(human.stderr).toEndWith(
		`\nRun: epicenter build words\nnot backed up\nRun: git -C ${join(f.home, 'words')} remote add origin <url>, then epicenter sync words\n`,
	);
});
