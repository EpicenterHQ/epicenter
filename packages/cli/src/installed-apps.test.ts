/**
 * Installing, approving, building, updating, and removing apps over real
 * repositories made in a temporary directory, with a build script that writes
 * `dist/` itself (ADR-0540, ADR-0552, ADR-0560). The last tests run the
 * command itself, `src/bin.ts` under Bun or the compiled binary that
 * `EPICENTER_BIN` names, for its NDJSON and exit codes.
 *
 * The monorepo tests install first-party apps from a clone of the Epicenter
 * repository. They need the network for `bun install` and a minute or more
 * each, so they run only when asked:
 *
 *   EPICENTER_MONOREPO=/path/to/epicenter-clone bun test src/installed-apps.test.ts
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type AppPaths, resolveAppPaths } from './app-paths.ts';
import {
	appIdProblem,
	currentBuild,
	FOLDER_KEY,
	type InstalledApp,
	inspect,
	install,
	listInstalled,
	listRepository,
	MANIFEST,
	normalizeFolder,
	parseManifest,
	readApprovals,
	recordApproval,
	remove,
	sourceProblem,
	update,
} from './installed-apps.ts';

// This machine's Git configuration must not change outcomes.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const binary = process.env.EPICENTER_BIN;
const command = binary
	? [resolve(binary)]
	: [process.execPath, '--no-install', resolve(import.meta.dir, 'bin.ts')];

const roots: string[] = [];
// A first-party install leaves a monorepo clone with its node_modules.
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
}, 120_000);

type Fixture = {
	root: string;
	paths: AppPaths;
	/** What the shell sets when it runs the CLI, for these paths. */
	env: Record<string, string>;
};

async function fixture(): Promise<Fixture> {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-installed-apps-')),
	);
	roots.push(root);
	const env = {
		EPICENTER_DATA_DIR: join(root, 'support'),
		EPICENTER_FOLDER_DIR: join(root, 'Epicenter'),
		EPICENTER_CACHE_DIR: join(root, 'caches'),
	};
	return { root, paths: resolveAppPaths(env), env };
}

/** `git` for the test's own repositories, with a fixed identity. */
function shGit(dir: string, ...args: string[]) {
	const result = Bun.spawnSync(['git', ...args], {
		cwd: dir,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Test',
			GIT_AUTHOR_EMAIL: 'test@localhost',
			GIT_COMMITTER_NAME: 'Test',
			GIT_COMMITTER_EMAIL: 'test@localhost',
		},
	});
	if (result.exitCode !== 0)
		throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

const BUILD = 'mkdir -p dist && cp page.html dist/index.html';
const BOARD_MANIFEST = '{ "id": "com.example.board", "title": "Board" }';
const BOARD = 'com.example.board';

/** A `package.json` whose `build:installed` script runs `script`. */
const packageJson = (script: string) =>
	JSON.stringify({
		name: 'board',
		private: true,
		scripts: { 'build:installed': script },
	});

async function writeAt(root: string, path: string, text: string) {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), text);
}

/** An app repository at `upstream/<name>`: a manifest, a `package.json`, and a page its build copies into `dist/`. */
async function appRepository(
	{ root }: Fixture,
	name: string,
	manifest = BOARD_MANIFEST,
	build = BUILD,
) {
	const repo = join(root, 'upstream', name);
	await mkdir(repo, { recursive: true });
	shGit(repo, 'init', '-q', '-b', 'main');
	await writeAt(repo, MANIFEST, manifest);
	await writeAt(repo, 'package.json', packageJson(build));
	await writeAt(repo, 'page.html', '<!doctype html><title>one</title>');
	await writeAt(repo, '.gitignore', 'dist/\nnode_modules/\n');
	shGit(repo, 'add', '-A');
	shGit(repo, 'commit', '-q', '-m', 'first');
	return repo;
}

async function commitPage(repo: string, text: string, message: string) {
	await writeFile(join(repo, 'page.html'), text);
	shGit(repo, 'commit', '-q', '-am', message);
	return shGit(repo, 'rev-parse', 'HEAD');
}

async function servedPage({ paths }: Fixture, id: string) {
	const builds = join(paths.buildsDir, id);
	const commit = await currentBuild(builds);
	if (commit === undefined) throw new Error('no current build');
	return readFile(join(builds, commit, 'index.html'), 'utf8');
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

function review(app: InstalledApp) {
	if (app.state.kind !== 'needsApproval')
		throw new Error(`not waiting for approval: ${JSON.stringify(app.state)}`);
	return app.state.review;
}

/** Approve `commit` of app `id`, as the Folders window's approval does. */
const approve = (paths: AppPaths, id: string, commit: string) =>
	update(paths, id, { commit, approve: true });

// ============================================================================
// The manifest, ids, folders, sources, and paths
// ============================================================================

test('manifests are checked before anything is installed', () => {
	expect(parseManifest(BOARD_MANIFEST)).toEqual({ id: BOARD, title: 'Board' });
	for (const [manifest, expected] of [
		['{ "id": "Board", "title": "Board" }', 'reverse-domain'],
		['{ "id": "board", "title": "Board" }', 'reverse-domain'],
		['{ "id": "com..board", "title": "Board" }', 'reverse-domain'],
		['{ "id": "so.epicenter", "title": "Epicenter" }', 'Epicenter itself'],
		['{ "id": "com.example.board", "title": " " }', 'title'],
		['{ "id": "com.example.board" }', 'missing field `title`'],
		['{ "title": "Board" }', 'missing field `id`'],
		// The fields ADR-0560 removed are refused, not ignored.
		[
			'{ "id": "com.example.board", "title": "B", "opens": "shape.json" }',
			'unknown field `opens`',
		],
		[
			'{ "id": "com.example.board", "title": "B", "build": "make" }',
			'unknown field `build`',
		],
		[
			'{ "id": "com.example.board", "title": "B", "output": "out" }',
			'unknown field `output`',
		],
		['not json', 'not a valid'],
	])
		expect(() => parseManifest(manifest as string)).toThrow(expected);
	// First-party apps install like any other (ADR-0552).
	expect(appIdProblem('so.epicenter.todos')).toBeUndefined();
	expect(appIdProblem('so.epicenter.capture')).toBeUndefined();
});

test('sources are URLs or absolute paths', () => {
	for (const source of [
		'https://github.com/example/board.git',
		'ssh://git@github.com/example/board.git',
		'git@github.com:example/board.git',
		'/Users/me/board',
	])
		expect(sourceProblem(source)).toBeUndefined();
	for (const source of [
		'',
		'--upload-pack=touch /tmp/x',
		'ext::sh -c touch% /tmp/x',
		'fd::3',
		'board',
		'relative/board',
		'ftp://example.com/board',
	])
		expect(sourceProblem(source)).toBeString();
});

test('folders are normalized and kept inside the repository', () => {
	expect(normalizeFolder('')).toBe('');
	expect(normalizeFolder(' / ')).toBe('');
	expect(normalizeFolder('.')).toBe('');
	expect(normalizeFolder('apps/todos/')).toBe('apps/todos');
	expect(normalizeFolder('./apps/todos')).toBe('apps/todos');
	for (const folder of [
		'../x',
		'apps/../../x',
		'.git',
		'node_modules/x',
		'a\0b',
	])
		expect(() => normalizeFolder(folder)).toThrow();
});

test("paths follow the shell's rule: an absolute override wins, else the release app's", () => {
	const home = '/home/me';
	const release = resolveAppPaths({}, home);
	expect(release.appsDir).toBe('/home/me/Epicenter/Apps');
	expect(release.approvalsFile).toEndWith('/so.epicenter/approvals.json');
	expect(release.buildsDir).toEndWith('/so.epicenter/builds');
	expect(
		resolveAppPaths(
			{
				EPICENTER_DATA_DIR: '/d',
				EPICENTER_FOLDER_DIR: '/f',
				EPICENTER_CACHE_DIR: '/c',
			},
			home,
		),
	).toEqual({
		appsDir: '/f/Apps',
		buildsDir: '/c/builds',
		approvalsFile: '/d/approvals.json',
		dataDir: '/d',
		cacheDir: '/c',
	});
	expect(resolveAppPaths({ EPICENTER_FOLDER_DIR: '' }, home).appsDir).toBe(
		'/home/me/Epicenter/Apps',
	);
	expect(() =>
		resolveAppPaths({ EPICENTER_CACHE_DIR: 'relative' }, home),
	).toThrow('EPICENTER_CACHE_DIR must be an absolute path');
});

test('approvals are kept per app, and a damaged file approves nothing', async () => {
	const { paths } = await fixture();
	const file = paths.approvalsFile;
	await recordApproval(file, 'com.example.a', 'a');
	await recordApproval(file, 'com.example.b', 'b');
	const approvals = await readApprovals(file);
	expect(Object.keys(approvals)).toEqual(['com.example.a', 'com.example.b']);
	expect(approvals['com.example.a']?.commit).toBe('a');
	expect(await readFile(file, 'utf8')).toContain('approvedAt');
	await writeFile(file, '{ not json');
	expect(await readApprovals(file)).toEqual({});
	await writeFile(
		file,
		'{ "com.example.a": { "commit": "a", "approvedAt": 1, "x": 1 } }',
	);
	expect(await readApprovals(file)).toEqual({});
});

// ============================================================================
// Installing, approving, building, updating
// ============================================================================

test('install clones and waits for approval, then approval builds', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	const first = shGit(upstream, 'rev-parse', 'HEAD');

	const pending = await install(f.paths, upstream, '');
	expect(pending).toMatchObject({
		id: BOARD,
		title: 'Board',
		source: upstream,
		folder: '',
		commit: first,
	});
	expect(review(pending).from).toBeNull();
	expect(review(pending).log).toContain('first');
	expect(review(pending).statement).toContain("runs the app's code");
	// Nothing ran: no approval, no build.
	expect(await exists(f.paths.approvalsFile)).toBe(false);
	expect(await exists(f.paths.buildsDir)).toBe(false);
	expect(await exists(join(f.paths.appsDir, BOARD, '.git'))).toBe(true);
	// The staging clone is gone.
	expect(await readdir(f.paths.appsDir)).toEqual([BOARD]);
	// Opening builds nothing until approved.
	const opened = await update(f.paths, BOARD, { commit: first });
	expect(opened.state.kind).toBe('needsApproval');
	expect(await exists(f.paths.buildsDir)).toBe(false);

	const ready = await approve(f.paths, BOARD, first);
	expect(ready.state).toEqual({ kind: 'ready' });
	expect((await readApprovals(f.paths.approvalsFile))[BOARD]?.commit).toBe(
		first,
	);
	expect(await servedPage(f, BOARD)).toBe('<!doctype html><title>one</title>');
	expect(await exists(join(f.paths.buildsDir, BOARD, `${first}.log`))).toBe(
		true,
	);
});

test('approval names the commit it was shown', async () => {
	const f = await fixture();
	const pending = await install(f.paths, await appRepository(f, 'board'), '');
	await expect(approve(f.paths, pending.id, '0'.repeat(40))).rejects.toThrow(
		'Review it again',
	);
	expect(await exists(f.paths.approvalsFile)).toBe(false);
});

test('a commit made here runs without asking and is recorded', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	await install(f.paths, upstream, '', { approve: true });

	const clone = join(f.paths.appsDir, BOARD);
	const local = await commitPage(
		clone,
		'<!doctype html><title>mine</title>',
		'mine',
	);
	expect((await inspect(f.paths, BOARD)).state).toEqual({ kind: 'unbuilt' });

	const ready = await update(f.paths, BOARD, { commit: local });
	expect(ready.state).toEqual({ kind: 'ready' });
	expect(ready.commit).toBe(local);
	expect(await servedPage(f, BOARD)).toBe('<!doctype html><title>mine</title>');
	expect((await readApprovals(f.paths.approvalsFile))[BOARD]?.commit).toBe(
		local,
	);
});

test('a fetched commit needs approval with its log and diff', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	const first = shGit(upstream, 'rev-parse', 'HEAD');
	await install(f.paths, upstream, '', { approve: true });

	const theirs = await commitPage(
		upstream,
		'<!doctype html><title>theirs</title>',
		'theirs',
	);
	const updated = await update(f.paths, BOARD);
	expect(updated.commit).toBe(theirs);
	expect(review(updated).from).toBe(first);
	expect(review(updated).log).toContain('theirs');
	expect(review(updated).diffStat).toContain('page.html');
	// The approved build still serves until the update is approved.
	expect(await servedPage(f, BOARD)).toBe('<!doctype html><title>one</title>');
	expect((await update(f.paths, BOARD, { commit: theirs })).state.kind).toBe(
		'needsApproval',
	);

	await approve(f.paths, BOARD, theirs);
	expect(await servedPage(f, BOARD)).toBe(
		'<!doctype html><title>theirs</title>',
	);
});

test('a pull merged by hand still needs approval', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	await install(f.paths, upstream, '', { approve: true });

	await commitPage(upstream, '<!doctype html><title>theirs</title>', 'theirs');
	const clone = join(f.paths.appsDir, BOARD);
	await writeFile(join(clone, 'notes.txt'), 'mine');
	shGit(clone, 'add', 'notes.txt');
	shGit(clone, 'commit', '-q', '-m', 'mine');
	// A merge made here brings in a commit that was fetched.
	shGit(clone, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
	expect((await inspect(f.paths, BOARD)).state.kind).toBe('needsApproval');
});

test('update rebases commits made here and stops on a conflict', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	await install(f.paths, upstream, '', { approve: true });
	const clone = join(f.paths.appsDir, BOARD);
	shGit(clone, 'config', 'user.name', 'Test');
	shGit(clone, 'config', 'user.email', 'test@localhost');

	// Unrelated commits on each side rebase cleanly.
	await writeFile(join(clone, 'notes.txt'), 'mine');
	shGit(clone, 'add', 'notes.txt');
	shGit(clone, 'commit', '-q', '-m', 'mine');
	await commitPage(upstream, '<!doctype html><title>theirs</title>', 'theirs');
	const updated = await update(f.paths, BOARD);
	expect(updated.state.kind).toBe('needsApproval');
	expect(await exists(join(clone, 'notes.txt'))).toBe(true);
	expect(await readFile(join(clone, 'page.html'), 'utf8')).toBe(
		'<!doctype html><title>theirs</title>',
	);

	// The same line changed on each side stops, and nothing changes.
	const before = await commitPage(
		clone,
		'<!doctype html><title>mine</title>',
		'mine again',
	);
	await commitPage(
		upstream,
		'<!doctype html><title>conflict</title>',
		'conflict',
	);
	await expect(update(f.paths, BOARD)).rejects.toThrow('conflict');
	expect(shGit(clone, 'rev-parse', 'HEAD')).toBe(before);
	expect(await exists(join(clone, '.git/rebase-merge'))).toBe(false);
});

test('an invalid manifest is refused and nothing is kept', async () => {
	const f = await fixture();
	const upstream = await appRepository(
		f,
		'board',
		'{ "id": "board", "title": "Board" }',
	);
	await expect(install(f.paths, upstream, '')).rejects.toThrow(
		'reverse-domain',
	);
	expect(await readdir(f.paths.appsDir)).toEqual([]);
});

test("Epicenter's id and a second install are refused", async () => {
	const f = await fixture();
	const epicenter = await appRepository(
		f,
		'epicenter',
		'{ "id": "so.epicenter", "title": "Epicenter" }',
	);
	await expect(install(f.paths, epicenter, '')).rejects.toThrow(
		'Epicenter itself',
	);
	const board = await appRepository(f, 'board');
	await install(f.paths, board, '');
	await expect(install(f.paths, board, '')).rejects.toThrow(
		'already installed',
	);
	expect(await readdir(f.paths.appsDir)).toEqual([BOARD]);
});

test('a failed build keeps the approval and serves nothing new', async () => {
	const f = await fixture();
	const upstream = await appRepository(
		f,
		'board',
		BOARD_MANIFEST,
		'echo broken >&2; exit 3',
	);
	const pending = await install(f.paths, upstream, '');
	await expect(approve(f.paths, pending.id, pending.commit)).rejects.toThrow(
		'did not build',
	);
	expect((await readApprovals(f.paths.approvalsFile))[BOARD]).toBeDefined();
	expect(await currentBuild(join(f.paths.buildsDir, BOARD))).toBeUndefined();
	const log = await readFile(
		join(f.paths.buildsDir, BOARD, `${pending.commit}.log`),
		'utf8',
	);
	expect(log).toContain('broken');
	expect((await inspect(f.paths, BOARD)).state).toEqual({ kind: 'unbuilt' });
});

test('uncommitted changes do not build', async () => {
	const f = await fixture();
	const pending = await install(f.paths, await appRepository(f, 'board'), '');
	await writeFile(join(f.paths.appsDir, BOARD, 'page.html'), 'edited');
	await expect(approve(f.paths, pending.id, pending.commit)).rejects.toThrow(
		'not committed',
	);
	expect(await exists(f.paths.approvalsFile)).toBe(false);
});

test('listing reads every installed app and reports a broken one', async () => {
	const f = await fixture();
	expect(await listInstalled(f.paths)).toEqual([]);
	await install(f.paths, await appRepository(f, 'board'), '');
	await mkdir(join(f.paths.appsDir, 'com.example.empty'));
	await mkdir(join(f.paths.appsDir, '.installing-left'));
	const listed = await listInstalled(f.paths);
	expect(listed.map((app) => app.id)).toEqual([BOARD, 'com.example.empty']);
	expect(listed[1]?.state.kind).toBe('broken');
});

test('git here runs no hook', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	await install(f.paths, upstream, '');
	const hooks = join(f.paths.appsDir, BOARD, '.git/hooks');
	await mkdir(hooks, { recursive: true });
	const marker = join(f.root, 'hook-ran');
	const hook = join(hooks, 'post-merge');
	await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
	await chmod(hook, 0o755);
	await commitPage(upstream, '<!doctype html><title>theirs</title>', 'theirs');
	await update(f.paths, BOARD);
	expect(await exists(marker)).toBe(false);
});

test('one machine runs one install at a time', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	await mkdir(f.paths.cacheDir, { recursive: true });
	const held = new Database(join(f.paths.cacheDir, 'apps.lock'), {
		create: true,
	});
	held.exec('BEGIN EXCLUSIVE');
	try {
		await expect(install(f.paths, upstream, '')).rejects.toThrow(
			'already installing',
		);
	} finally {
		held.exec('COMMIT');
		held.close();
	}
	expect((await install(f.paths, upstream, '')).id).toBe(BOARD);
});

test('removing an app deletes its clone, builds, and approval, but never work no remote has', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	await install(f.paths, upstream, '', { approve: true });
	const clone = join(f.paths.appsDir, BOARD);
	await commitPage(clone, '<!doctype html><title>mine</title>', 'mine');
	await expect(remove(f.paths, BOARD)).rejects.toThrow('1 commit made here');
	shGit(clone, 'reset', '-q', '--hard', 'origin/main');
	await writeFile(join(clone, 'page.html'), 'edited');
	await expect(remove(f.paths, BOARD)).rejects.toThrow('not committed');
	shGit(clone, 'checkout', '-q', '--', 'page.html');

	await remove(f.paths, BOARD);
	expect(await exists(clone)).toBe(false);
	expect(await exists(join(f.paths.buildsDir, BOARD))).toBe(false);
	expect(await readApprovals(f.paths.approvalsFile)).toEqual({});
	await expect(remove(f.paths, BOARD)).rejects.toThrow('No app is installed');
});

// ============================================================================
// Apps in folders of a repository (ADR-0552)
// ============================================================================

/**
 * A monorepo with no root `package.json`, so the `bun install` step is
 * skipped, and two apps in folders, with a manifest under `node_modules` and
 * one too deep that listing skips. Only Board builds.
 */
async function monorepo({ root }: Fixture) {
	const repo = join(root, 'upstream', 'mono');
	await mkdir(repo, { recursive: true });
	shGit(repo, 'init', '-q', '-b', 'main');
	await writeAt(repo, '.gitignore', 'dist/\nnode_modules/\n');
	await writeAt(repo, 'apps/board/epicenter.app.json', BOARD_MANIFEST);
	await writeAt(repo, 'apps/board/package.json', packageJson(BUILD));
	await writeAt(
		repo,
		'apps/board/page.html',
		'<!doctype html><title>board</title>',
	);
	await writeAt(
		repo,
		'apps/notes/epicenter.app.json',
		'{ "id": "com.example.notes", "title": "Notes" }',
	);
	await writeAt(repo, 'apps/broken/epicenter.app.json', 'not json');
	await writeAt(
		repo,
		'node_modules/dep/epicenter.app.json',
		'{ "id": "com.example.dep", "title": "Dep" }',
	);
	await writeAt(
		repo,
		'a/b/c/d/e/epicenter.app.json',
		'{ "id": "com.example.deep", "title": "Deep" }',
	);
	shGit(repo, 'add', '-A', '-f');
	shGit(repo, 'commit', '-q', '-m', 'first');
	return repo;
}

test('listing a repository finds each app folder and keeps nothing', async () => {
	const f = await fixture();
	const mono = await monorepo(f);
	const found = await listRepository(f.paths, mono);
	expect(found.map((app) => app.folder)).toEqual([
		'apps/board',
		'apps/broken',
		'apps/notes',
	]);
	expect(found[0]).toEqual({
		folder: 'apps/board',
		id: BOARD,
		title: 'Board',
		problem: null,
		installed: false,
	});
	expect(found[1]?.problem).toContain('not a valid');
	expect(await readdir(f.paths.appsDir)).toEqual([]);

	await install(f.paths, mono, 'apps/board');
	expect((await listRepository(f.paths, mono))[0]?.installed).toBe(true);
});

test('an app in a folder installs, records its folder, and builds there', async () => {
	const f = await fixture();
	const mono = await monorepo(f);
	const first = shGit(mono, 'rev-parse', 'HEAD');

	const pending = await install(f.paths, mono, '/apps/board/');
	expect(pending).toMatchObject({
		id: BOARD,
		folder: 'apps/board',
		commit: first,
	});
	const clone = join(f.paths.appsDir, BOARD);
	expect(shGit(clone, 'config', '--local', '--get', FOLDER_KEY)).toBe(
		'apps/board',
	);
	// The whole repository is cloned.
	expect(await exists(join(clone, 'apps/notes/epicenter.app.json'))).toBe(true);

	const ready = await approve(f.paths, BOARD, first);
	expect(ready.state).toEqual({ kind: 'ready' });
	expect(ready.folder).toBe('apps/board');
	expect(await servedPage(f, BOARD)).toBe(
		'<!doctype html><title>board</title>',
	);
	// The build ran in the app's folder.
	expect(await exists(join(clone, 'apps/board/dist/index.html'))).toBe(true);
	expect(await exists(join(clone, 'dist'))).toBe(false);
	expect((await listInstalled(f.paths))[0]?.folder).toBe('apps/board');
});

test('a folder without an app, or outside the repository, is refused', async () => {
	const f = await fixture();
	const mono = await monorepo(f);
	for (const [folder, expected] of [
		['apps', 'apps/epicenter.app.json is missing'],
		['apps/missing', 'no folder'],
		['../elsewhere', 'inside the repository'],
	] as const)
		await expect(install(f.paths, mono, folder)).rejects.toThrow(expected);
	expect(await readdir(f.paths.appsDir).catch(() => [])).toEqual([]);
});

test('a damaged folder record breaks the app instead of reading elsewhere', async () => {
	const f = await fixture();
	const mono = await monorepo(f);
	const pending = await install(f.paths, mono, 'apps/board');
	shGit(
		join(f.paths.appsDir, pending.id),
		'config',
		'--local',
		FOLDER_KEY,
		'../../elsewhere',
	);
	const app = await inspect(f.paths, pending.id);
	expect(app.state.kind).toBe('broken');
	expect(app.state.kind === 'broken' && app.state.problem).toContain(
		FOLDER_KEY,
	);
});

// ============================================================================
// The command: NDJSON, exit codes, and the shell's environment
// ============================================================================

function run(env: Record<string, string>, ...args: string[]) {
	const result = Bun.spawnSync([...command, ...args], {
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const stdout = result.stdout.toString();
	return {
		exitCode: result.exitCode,
		stdout,
		stderr: result.stderr.toString(),
		lines: stdout
			.split('\n')
			.filter(Boolean)
			.flatMap((line): Record<string, unknown>[] => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			}),
	};
}

test('app install and update stream progress and end with the app, exiting 1 while it waits for approval', async () => {
	const f = await fixture();
	const mono = await monorepo(f);

	const listedRepository = run(
		f.env,
		'app',
		'list',
		'--repository',
		mono,
		'--json',
	);
	expect(listedRepository.exitCode).toBe(0);
	expect(listedRepository.lines[0]?.source).toBe(mono);

	const installed = run(
		f.env,
		'app',
		'install',
		mono,
		'--folder',
		'apps/board',
		'--json',
		'--desktop',
	);
	expect(installed.exitCode).toBe(1);
	expect(installed.lines[0]).toEqual({ progress: `Cloning ${mono}…` });
	const pending = installed.lines.at(-1)?.app as InstalledApp;
	expect(pending.state.kind).toBe('needsApproval');

	const stale = run(
		f.env,
		'app',
		'update',
		'--commit',
		'0'.repeat(40),
		'--approve',
		'--json',
		'--',
		BOARD,
	);
	expect(stale.exitCode).toBe(2);
	expect(stale.lines.at(-1)?.error).toContain('Review it again');

	const approved = run(
		f.env,
		'app',
		'update',
		'--commit',
		pending.commit,
		'--approve',
		'--json',
		'--',
		BOARD,
	);
	expect(approved.exitCode).toBe(0);
	expect(approved.lines.map((line) => line.progress).filter(Boolean)).toContain(
		'Building Board…',
	);
	expect((approved.lines.at(-1)?.app as InstalledApp).state).toEqual({
		kind: 'ready',
	});

	const listed = run(f.env, 'app', 'list', '--json');
	expect(listed.exitCode).toBe(0);
	expect(listed.lines).toHaveLength(1);
	expect(
		(listed.lines[0]?.apps as InstalledApp[]).map(({ id, state }) => ({
			id,
			state,
		})),
	).toEqual([{ id: BOARD, state: { kind: 'ready' } }]);
	expect(run(f.env, 'app', 'list').stdout).toStartWith(
		`${BOARD}\tBoard\tready`,
	);

	const text = run(f.env, 'app', 'install', mono, '--folder', 'apps/notes');
	expect(text.exitCode).toBe(1);
	expect(text.stderr).toContain('Cloning');
	expect(text.stdout).toContain(
		'Notes (com.example.notes) is waiting for approval',
	);
	expect(text.stdout).toContain(
		'epicenter app update com.example.notes --approve',
	);
	expect(run(f.env, 'app', 'remove', BOARD, '--json').lines).toEqual([
		{ removed: BOARD },
	]);
});

// ============================================================================
// First-party apps from a clone of the Epicenter repository
// ============================================================================

const monorepoClone = process.env.EPICENTER_MONOREPO;

describe.skipIf(monorepoClone === undefined)(
	'installing from the Epicenter repository',
	() => {
		for (const [folder, id, title] of [
			['apps/todos', 'so.epicenter.todos', 'Todos'],
			['apps/capture', 'so.epicenter.capture', 'Capture'],
			['apps/whispering', 'so.epicenter.whispering', 'Whispering'],
			['apps/honeycrisp', 'so.epicenter.honeycrisp', 'Honeycrisp'],
		] as const)
			test(
				`installs ${title} from its folder, built with relative asset paths`,
				async () => {
					const f = await fixture();
					const source = monorepoClone as string;
					const listed = run(
						f.env,
						'app',
						'list',
						'--repository',
						source,
						'--json',
					);
					const found = (
						listed.lines[0]?.apps as {
							folder: string;
							id: string;
							problem: string | null;
						}[]
					).find((app) => app.folder === folder);
					expect(found).toMatchObject({ id, problem: null });

					const installed = run(
						f.env,
						'app',
						'install',
						source,
						'--folder',
						folder,
						'--approve',
						'--json',
					);
					const result = installed.lines.at(-1);
					if (installed.exitCode !== 0) {
						const app = (await inspect(f.paths, id).catch(() => undefined)) ?? {
							commit: '',
						};
						const log = await readFile(
							join(f.paths.buildsDir, id, `${app.commit}.log`),
							'utf8',
						).catch(() => '');
						throw new Error(`${JSON.stringify(result)}\n${log}`);
					}
					const app = result?.app as InstalledApp;
					expect(app).toMatchObject({
						id,
						title,
						folder,
						state: { kind: 'ready' },
					});
					const clone = join(f.paths.appsDir, id);
					expect(shGit(clone, 'config', '--local', '--get', FOLDER_KEY)).toBe(
						folder,
					);
					expect(await exists(join(clone, 'node_modules'))).toBe(true);

					const page = await servedPage(f, id);
					expect(page).not.toContain('/apps/');
					expect(page).toContain('href="./_app/');
					expect(page).not.toMatch(/(href|src)="\//);
					const listedApps = run(f.env, 'app', 'list', '--json').lines[0]
						?.apps as InstalledApp[];
					expect(listedApps.map((listedApp) => listedApp.id)).toEqual([id]);
				},
				15 * 60 * 1000,
			);
	},
);
