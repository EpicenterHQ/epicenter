/**
 * Starter update tests: cloning, merging, collection problem reporting, and
 * UI builds. Sync coverage checks that an origin receives only home pushes.
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
	path: 'words/{word}.md',
	fields: { meaning: field.text(), reading: ${field} },
});

export default defineApp({
	description: 'Words I am learning',
	collections: { words },
	actions: { words: words.actions() },
});
`;
}

/** A `ui/` whose build writes `label` to `build/index.html`, without a dependency to install. */
function uiPackage(build: string) {
	return `${JSON.stringify({ name: 'ui', private: true, scripts: { build } })}\n`;
}
const builds = (label: string) =>
	uiPackage(`mkdir -p build && echo ${label} > build/index.html`);

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
		'ui/.gitignore': 'build/\nbuild.last/\nnode_modules/\n',
	});
	return { ...f, starter, app: join(f.home, 'vocab') };
}

test('new --from clones a starter as upstream, tracking nothing, and builds its UI', async () => {
	const f = await starterFixture();
	const made = await f.run('new', 'vocab', '--from', f.starter, '--json');
	expect(made.code).toBe(0);
	expect(made.stderr).toEndWith(
		`not backed up\nRun: git -C ${f.app} remote add origin <url>, then epicenter sync vocab\n`,
	);
	expect(await gitIn(f.app, 'remote')).toBe('upstream');
	expect(
		await gitIn(f.app, 'config', '--get-regexp', '^branch\\.').catch(() => ''),
	).toBe('');
	expect(await readFile(join(f.app, 'ui', 'build', 'index.html'), 'utf8')).toBe(
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
		`${header}defineCollection({ path: 'words/', fields: {} });\n`,
	);
	await commitAll(f.starter, 'break the app');
	const made = await f.run('new', 'vocab', '--from', f.starter, '--json');
	expect(made.code).toBe(2);
	expect(JSON.parse(made.stdout).error).toMatchObject({
		name: 'AppProblems',
		problems: ['epicenter.ts: The collection path words/ is not a .md path'],
	});
	expect(existsSync(f.app)).toBe(false);
});

test('update merges the starter, lists files that no longer fit, and builds', async () => {
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
		misfits: [],
	});

	await writeFile(
		join(f.starter, 'epicenter.ts'),
		wordsApp({ reading: 'required' }),
	);
	await writeFile(join(f.starter, 'ui', 'package.json'), builds('two'));
	await commitAll(f.starter, 'require a reading');
	const updated = await f.run('update');
	expect(updated.code).toBe(0);
	expect(updated.stdout).toMatch(
		/^vocab: merged [0-9a-f]+; UI built; 1 file does not fit its fields\n {2}words\/neko\.md: reading is missing$/m,
	);
	expect(await gitIn(f.app, 'log', '-1', '--format=%s')).toBe(
		'vocab: update from upstream',
	);
	expect(await readFile(join(f.app, 'ui', 'build', 'index.html'), 'utf8')).toBe(
		'two\n',
	);
	expect(await gitIn(f.app, 'status', '--porcelain')).toBe('');
});

test('update reports problems from a one-file collection get', async () => {
	const f = await fixture();
	roots.push(f.root);
	const starter = await f.folder(join(f.root, 'single-starter'), {
		'.gitignore': gitignore,
		'epicenter.ts': `${header}const settings = defineCollection({ path: 'settings.md', fields: { mode: field.text({ optional: true }) } });
export default defineApp({ description: 'Settings', collections: { settings }, actions: {} });\n`,
	});
	expect((await f.run('new', 'settings', '--from', starter)).code).toBe(0);
	const app = join(f.home, 'settings');
	await writeFile(join(app, 'settings.md'), '---\nmode: 42\n---\n');
	await commitAll(app, 'invalid setting');
	const updated = await f.run('update', 'settings', '--json');
	expect(updated.code).toBe(0);
	expect(JSON.parse(updated.stdout).apps[0].misfits).toEqual([
		'settings.md: mode: 42 is not text',
	]);
});

test('update refuses an app with changes, and undoes a merge that conflicts', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);

	await writeFile(join(f.app, 'notes.md'), 'unsaved\n');
	const dirty = await f.run('update', 'vocab', '--json');
	expect(dirty.code).toBe(1);
	expect(JSON.parse(dirty.stdout).apps[0].error).toEqual({
		message: expect.stringContaining('uncommitted changes'),
		next: 'epicenter sync vocab',
	});
	await rm(join(f.app, 'notes.md'));

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
	expect(await readFile(join(f.app, 'ui', 'build', 'index.html'), 'utf8')).toBe(
		'one\n',
	);
});

test('a build that removes its output keeps the last UI and names the required index', async () => {
	const f = await starterFixture();
	expect((await f.run('new', 'vocab', '--from', f.starter)).code).toBe(0);
	await writeFile(
		join(f.starter, 'ui', 'package.json'),
		uiPackage('rm -rf build'),
	);
	await commitAll(f.starter, 'empty the build');
	const updated = await f.run('update', 'vocab');
	expect(updated.code).toBe(1);
	expect(updated.stderr).toContain('ui/build/index.html');
	expect(await readFile(join(f.app, 'ui', 'build', 'index.html'), 'utf8')).toBe(
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
	expect(JSON.parse((await f.run('vocab', '--json')).stdout)).toHaveProperty(
		'status.backup',
		'never',
	);
	const synced = await f.run('sync', 'vocab', '--json');
	expect(synced.code).toBe(0);
	expect(JSON.parse(synced.stdout).apps[0]).toMatchObject({
		pushed: true,
		origin: { ahead: 0, behind: 0 },
	});
	const branch = await gitIn(f.app, 'symbolic-ref', '--short', 'HEAD');
	expect(await gitIn(backup, 'rev-parse', branch)).toBe(
		await gitIn(f.app, 'rev-parse', 'HEAD'),
	);
	expect(await gitIn(f.starter, 'rev-parse', 'HEAD')).toBe(starterHead);
});

test('new --from whose UI does not build makes the app, exits 1, and names update', async () => {
	const f = await starterFixture();
	await writeFile(join(f.starter, 'ui', 'package.json'), uiPackage('exit 7'));
	await commitAll(f.starter, 'break the build');
	const made = await f.run('new', 'vocab', '--from', f.starter, '--json');
	expect(made.code).toBe(1);
	expect(JSON.parse(made.stdout).error).toMatchObject({
		name: 'BuildFailed',
		next: 'epicenter update vocab',
	});
	expect(made.stderr).toEndWith(
		`not backed up\nRun: git -C ${f.app} remote add origin <url>, then epicenter sync vocab\n`,
	);
	expect(await gitIn(f.app, 'remote')).toBe('upstream');
});
