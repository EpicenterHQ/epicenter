/**
 * Starter update tests: cloning, merging, and UI builds. Sync coverage
 * checks that code and data push to their own origins, never the starter.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
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

test('new --from clones a starter as upstream, tracking nothing, and builds nothing itself', async () => {
	const f = await starterFixture();
	const made = await f.run('new', 'vocab', '--from', f.starter, '--json');
	expect(made.code).toBe(0);
	expect(await gitIn(f.app, 'remote')).toBe('upstream');
	expect(await gitIn(join(f.app, 'data'), 'log', '-1', '--format=%s')).toBe(
		'vocab: start its data',
	);
	expect(
		await gitIn(f.app, 'config', '--get-regexp', '^branch\\.').catch(() => ''),
	).toBe('');
	expect(existsSync(join(f.app, 'ui', 'dist'))).toBe(false);
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
		problems: [
			'epicenter.ts: The collection path data/words/ is not a .md path',
		],
	});
	expect(existsSync(f.app)).toBe(false);
});

test('update merges the starter; a file that no longer fits says so when read', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);
	expect(
		(await f.run('vocab', 'words', 'add', 'neko', '--meaning', 'cat')).code,
	).toBe(0);

	const quiet = JSON.parse((await f.run('update', 'vocab', '--json')).stdout);
	expect(quiet.apps[0]).toMatchObject({
		remote: 'upstream',
		found: true,
		merged: null,
	});
	await writeFile(join(f.app, 'LOCAL.md'), 'my notes\n');
	await commitAll(f.app, 'my code notes');

	await writeFile(
		join(f.starter, 'epicenter.ts'),
		wordsApp({ reading: 'required' }),
	);
	await writeFile(join(f.starter, 'ui', 'package.json'), builds('two'));
	await commitAll(f.starter, 'require a reading');
	const updated = await f.run('update');
	expect(updated.code).toBe(0);
	expect(updated.stdout).toMatch(/^vocab: merged [0-9a-f]+\n$/);
	expect(await gitIn(f.app, 'log', '-1', '--format=%s')).toBe(
		'vocab: update from upstream',
	);
	expect(await gitIn(f.app, 'status', '--porcelain')).toBe('');
	const read = await f.run(
		'vocab',
		'words',
		'get',
		'data/words/neko.md',
		'--json',
	);
	expect(JSON.parse(read.stdout).returned.problems).toEqual([
		'reading is missing',
	]);
});

test('update snapshots pending changes before it merges, and undoes a merge that conflicts', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);

	await writeFile(join(f.app, 'data/notes.md'), 'unsaved\n');
	await writeFile(join(f.app, 'LOCAL.md'), 'my notes\n');
	await writeFile(join(f.starter, 'README.md'), 'about vocab\n');
	await commitAll(f.starter, 'add a readme');
	const pending = await f.run('update', 'vocab');
	expect(pending.code).toBe(0);
	expect(await gitIn(f.app, 'log', '--first-parent', '-2', '--format=%s')).toBe(
		'vocab: update from upstream\nvocab: changed outside epicenter',
	);
	expect(await gitIn(join(f.app, 'data'), 'log', '-1', '--format=%s')).toBe(
		'vocab: changed outside epicenter',
	);
	expect(await readFile(join(f.app, 'data/notes.md'), 'utf8')).toBe(
		'unsaved\n',
	);
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

test('sync pushes to origin, never to the starter', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);
	const starterHead = await gitIn(f.starter, 'rev-parse', 'HEAD');

	const alone = JSON.parse((await f.run('sync', 'vocab', '--json')).stdout);
	expect(alone.apps[0].code).toMatchObject({ pushed: false, origin: null });
	expect(alone.apps[0].data).toMatchObject({ pushed: false, origin: null });

	const backup = join(f.root, 'backup.git');
	await gitIn(f.root, 'init', '-q', '--bare', backup);
	await gitIn(f.app, 'remote', 'add', 'origin', backup);
	expect(
		(await f.run('vocab', 'words', 'add', 'neko', '--meaning', 'cat')).code,
	).toBe(0);
	expect(JSON.parse((await f.run('vocab', '--json')).stdout).status).toEqual({
		code: { pending: 0, backup: 'never' },
		data: { pending: 0, backup: 'none' },
	});
	const synced = await f.run('sync', 'vocab', '--json');
	expect(synced.code).toBe(0);
	expect(JSON.parse(synced.stdout).apps[0].code).toMatchObject({
		pushed: true,
		origin: { ahead: 0 },
	});
	const branch = await gitIn(f.app, 'symbolic-ref', '--short', 'HEAD');
	expect(await gitIn(backup, 'rev-parse', branch)).toBe(
		await gitIn(f.app, 'rev-parse', 'HEAD'),
	);
	expect(await gitIn(f.starter, 'rev-parse', 'HEAD')).toBe(starterHead);
});

test('update from a named remote finds its default branch when remote HEAD is missing', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);
	await gitIn(f.app, 'remote', 'rename', 'upstream', 'source');
	await gitIn(f.app, 'remote', 'set-head', 'source', '--delete').catch(
		() => '',
	);
	expect(
		await gitIn(f.app, 'symbolic-ref', 'refs/remotes/source/HEAD').catch(
			() => '',
		),
	).toBe('');
	await writeFile(join(f.app, 'LOCAL.md'), 'my notes\n');
	await commitAll(f.app, 'my code notes');
	await writeFile(join(f.starter, 'README.md'), 'new starter text\n');
	await commitAll(f.starter, 'new starter text');
	const updated = await f.run('update', 'vocab', 'source', '--json');
	expect(updated.code).toBe(0);
	expect(JSON.parse(updated.stdout).apps[0]).toMatchObject({
		remote: 'source',
		found: true,
		merged: expect.any(String),
	});
	expect(
		await gitIn(f.app, 'symbolic-ref', 'refs/remotes/source/HEAD'),
	).toMatch(/^refs\/remotes\/source\//);
	expect(await gitIn(f.app, 'log', '-1', '--format=%s')).toBe(
		'vocab: update from source',
	);
});
