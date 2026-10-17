/**
 * Installing, approving, building, updating, opening, and removing apps over
 * real repositories made in a temporary directory, with a build script that
 * writes `dist/` itself (ADR-0540, ADR-0552, ADR-0560, ADR-0588, ADR-0597).
 * The last tests run the command itself, `src/bin.ts` under Bun or the
 * compiled binary that `EPICENTER_BIN` names, for its NDJSON and exit codes.
 *
 * Key behaviors:
 * - an installed app is a bare clone whose detached `HEAD` is the approved
 *   commit: fetching never moves it, approving does, and a fetched commit
 *   never runs until approved
 * - a build directory is a `git archive` of the commit's build tree, checked
 *   at every open; a damaged one gets a fresh copy beside it for the shell
 *   to swap in, and a missing one is extracted again without building
 * - an `approvals.json` or `current` file left by an earlier install is
 *   ignored
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
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { NEUTRAL_ATTRIBUTES } from '@epicenter/folder/bun';
import { type AppPaths, resolveAppPaths } from './app-paths.ts';
import {
	appIdProblem,
	FOLDER_KEY,
	type InstalledApp,
	inspect,
	install,
	listInstalled,
	listRepository,
	MANIFEST,
	normalizeFolder,
	parseManifest,
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

/** The page a newly opened window of app `id` loads: its approved commit's build. */
async function servedPage({ paths }: Fixture, id: string) {
	const { commit } = await inspect(paths, id);
	if (commit === '') throw new Error('no approved commit');
	return readFile(join(paths.buildsDir, id, commit, 'index.html'), 'utf8');
}

/** What the clone's `HEAD` file holds: a commit when detached, `ref: …` when symbolic. */
async function headFile({ paths }: Fixture, id: string) {
	return (await readFile(join(paths.appsDir, id, 'HEAD'), 'utf8')).trim();
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

function pending(app: InstalledApp) {
	if (app.pending === null)
		throw new Error(`nothing waits for approval: ${JSON.stringify(app)}`);
	return app.pending;
}

/** Approve `commit` of app `id`, as the Folders window's approval does. */
const approve = (paths: AppPaths, id: string, commit: string) =>
	update(paths, id, { commit, approve: true });

/** Open app `id` at `commit`, as the shell asks before every open. */
const open = (paths: AppPaths, id: string, commit: string) =>
	update(paths, id, { commit });

/** Open app `id` at `commit` while no window runs it, as the shell asks then. */
const openRestoring = (paths: AppPaths, id: string, commit: string) =>
	update(paths, id, { commit, restore: true });

/** Install Board from a new upstream and approve its first commit. */
async function installedBoard(f: Fixture) {
	const upstream = await appRepository(f, 'board');
	const first = shGit(upstream, 'rev-parse', 'HEAD');
	await install(f.paths, upstream, '', { approve: true, commit: first });
	return { upstream, first, builds: join(f.paths.buildsDir, BOARD) };
}

/** Run `work` with `config` as Git's global configuration file. */
async function withGlobalConfig<T>(
	{ root }: Fixture,
	config: string,
	work: () => Promise<T>,
): Promise<T> {
	const file = join(root, 'global.gitconfig');
	await writeFile(file, config);
	process.env.GIT_CONFIG_GLOBAL = file;
	try {
		return await work();
	} finally {
		process.env.GIT_CONFIG_GLOBAL = '/dev/null';
	}
}

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
	expect(release.appsDir).toBe(
		'/home/me/Library/Application Support/so.epicenter/apps',
	);
	expect(release.buildsDir).toBe('/home/me/Library/Caches/so.epicenter/builds');
	expect(release.commandLink).toBe('/home/me/.local/bin/epicenter');
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
		appsDir: '/d/apps',
		folderDir: '/f',
		buildsDir: '/c/builds',
		dataDir: '/d',
		commandLink: '/home/me/.local/bin/epicenter',
		cacheDir: '/c',
	});
	expect(resolveAppPaths({ EPICENTER_DATA_DIR: '' }, home).appsDir).toBe(
		'/home/me/Library/Application Support/so.epicenter/apps',
	);
	expect(() =>
		resolveAppPaths({ EPICENTER_CACHE_DIR: 'relative' }, home),
	).toThrow('EPICENTER_CACHE_DIR must be an absolute path');
});

// ============================================================================
// The approved commit is the bare clone's detached HEAD
// ============================================================================

test('install clones bare and approves nothing, then approval detaches HEAD and builds', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	shGit(upstream, 'tag', 'v1');
	shGit(upstream, 'branch', 'template');
	const first = shGit(upstream, 'rev-parse', 'HEAD');

	const waiting = await install(f.paths, upstream, '');
	expect(waiting).toMatchObject({
		id: BOARD,
		title: 'Board',
		source: upstream,
		folder: '',
		commit: '',
		state: { kind: 'needsApproval' },
	});
	expect(pending(waiting)).toMatchObject({ commit: first, from: null });
	expect(pending(waiting).log).toContain('first');
	expect(pending(waiting).statement).toContain("runs the app's code");

	// A bare clone of the default branch alone, without tags, its HEAD
	// symbolic, its attributes neutral.
	const clone = join(f.paths.appsDir, BOARD);
	expect(shGit(clone, 'rev-parse', '--is-bare-repository')).toBe('true');
	expect(shGit(clone, 'config', '--get-all', 'remote.origin.fetch')).toBe(
		'+refs/heads/main:refs/remotes/origin/main',
	);
	expect(shGit(clone, 'config', 'remote.origin.tagOpt')).toBe('--no-tags');
	expect(shGit(clone, 'tag', '--list')).toBe('');
	expect(shGit(clone, 'for-each-ref', '--format=%(refname)')).not.toContain(
		'template',
	);
	expect(await readFile(join(clone, 'info/attributes'), 'utf8')).toBe(
		`${NEUTRAL_ATTRIBUTES}\n`,
	);
	expect(await headFile(f, BOARD)).toBe('ref: refs/heads/main');
	// Nothing ran, and the staging clone is gone.
	expect(await exists(f.paths.buildsDir)).toBe(false);
	expect(await readdir(f.paths.appsDir)).toEqual([BOARD]);
	// Opening builds nothing until approved.
	expect((await open(f.paths, BOARD, first)).state.kind).toBe('needsApproval');
	expect(await exists(f.paths.buildsDir)).toBe(false);

	const ready = await approve(f.paths, BOARD, first);
	expect(ready).toMatchObject({
		commit: first,
		state: { kind: 'ready' },
		pending: null,
	});
	expect(await headFile(f, BOARD)).toBe(first);
	expect(await servedPage(f, BOARD)).toBe('<!doctype html><title>one</title>');
	expect(await exists(join(f.paths.buildsDir, BOARD, `${first}.log`))).toBe(
		true,
	);
	expect(
		shGit(clone, 'ls-tree', '--name-only', `refs/epicenter/builds/${first}`),
	).toBe('index.html');
	// The source it built from is gone.
	expect(await exists(join(f.paths.cacheDir, 'sources', BOARD))).toBe(false);
});

test('fetching never moves HEAD, and approving does', async () => {
	const f = await fixture();
	const { upstream, first, builds } = await installedBoard(f);
	const theirs = await commitPage(
		upstream,
		'<!doctype html><title>theirs</title>',
		'theirs',
	);

	const fetched = await update(f.paths, BOARD);
	expect(await headFile(f, BOARD)).toBe(first);
	expect(fetched).toMatchObject({ commit: first, state: { kind: 'ready' } });
	expect(pending(fetched)).toMatchObject({ commit: theirs, from: first });
	expect(pending(fetched).log).toContain('theirs');
	expect(pending(fetched).diffStat).toContain('page.html');
	// The approved commit still opens while the update waits.
	expect((await open(f.paths, BOARD, first)).state).toEqual({ kind: 'ready' });

	const approved = await approve(f.paths, BOARD, theirs);
	expect(approved).toMatchObject({ commit: theirs, pending: null });
	expect(await headFile(f, BOARD)).toBe(theirs);
	expect(await servedPage(f, BOARD)).toBe(
		'<!doctype html><title>theirs</title>',
	);
	// The first build stays for a window still running it.
	expect(await readFile(join(builds, first, 'index.html'), 'utf8')).toBe(
		'<!doctype html><title>one</title>',
	);
});

test('a fetched commit never runs until it is approved', async () => {
	const f = await fixture();
	const { upstream, first, builds } = await installedBoard(f);
	const theirs = await commitPage(
		upstream,
		'<!doctype html><title>theirs</title>',
		'theirs',
	);
	await update(f.paths, BOARD);
	const clone = join(f.paths.appsDir, BOARD);
	// Pulling or merging by hand cannot move HEAD in a bare clone.
	expect(() => shGit(clone, 'merge', '--ff-only', 'origin/main')).toThrow(
		'must be run in a work tree',
	);
	expect(() => shGit(clone, 'pull', '--ff-only')).toThrow(
		'must be run in a work tree',
	);

	await expect(open(f.paths, BOARD, theirs)).rejects.toThrow('Review it again');
	expect(await exists(join(builds, theirs))).toBe(false);
	expect(
		shGit(clone, 'for-each-ref', '--format=%(refname)', 'refs/epicenter'),
	).toBe(`refs/epicenter/builds/${first}`);
	expect(await servedPage(f, BOARD)).toBe('<!doctype html><title>one</title>');
});

test('approval names the commit it was shown', async () => {
	const f = await fixture();
	const waiting = await install(f.paths, await appRepository(f, 'board'), '');
	await expect(approve(f.paths, waiting.id, '0'.repeat(40))).rejects.toThrow(
		'Review it again',
	);
	expect(await headFile(f, BOARD)).toBe('ref: refs/heads/main');
});

test('a commit whose manifest names another id is never approved', async () => {
	const f = await fixture();
	const { upstream, first } = await installedBoard(f);
	await writeFile(
		join(upstream, MANIFEST),
		'{ "id": "com.example.other", "title": "Other" }',
	);
	shGit(upstream, 'commit', '-q', '-am', 'rename');
	const renamed = pending(await update(f.paths, BOARD)).commit;
	await expect(approve(f.paths, BOARD, renamed)).rejects.toThrow(
		"names the id 'com.example.other'",
	);
	expect(await headFile(f, BOARD)).toBe(first);
});

test('an upstream branch named like a build ref never supplies the build', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	const benign = shGit(upstream, 'rev-parse', 'HEAD');
	// An orphan commit of the same app whose page is not the reviewed one,
	// published under the branch name a build ref of `benign` would have.
	// Its root holds an index.html, so its tree would serve as a build.
	shGit(upstream, 'checkout', '-q', '--orphan', 'planted');
	await writeFile(join(upstream, 'index.html'), 'PLANTED');
	shGit(upstream, 'add', 'index.html');
	shGit(upstream, 'commit', '-q', '-m', 'planted');
	const branch = `refs/epicenter/builds/${benign}`;
	shGit(upstream, 'branch', '-q', '-m', branch);
	shGit(upstream, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);

	await install(f.paths, upstream, '');
	// The upstream then moves the branch to the benign commit, which a person
	// reviews and approves.
	shGit(upstream, 'update-ref', `refs/heads/${branch}`, benign);
	const fetched = await update(f.paths, BOARD);
	expect(pending(fetched).commit).toBe(benign);
	await approve(f.paths, BOARD, benign);
	expect(await servedPage(f, BOARD)).toBe('<!doctype html><title>one</title>');
	// No local branch is kept, so no name can stand in for another ref.
	const clone = join(f.paths.appsDir, BOARD);
	expect(
		shGit(clone, 'for-each-ref', '--format=%(refname)', 'refs/heads'),
	).toBe('');
});

test('a build ref that names anything but a tree is never served', async () => {
	const f = await fixture();
	const { upstream, first, builds } = await installedBoard(f);
	// A commit whose root holds an index.html, so its tree would serve.
	await writeFile(join(upstream, 'index.html'), 'OTHER');
	shGit(upstream, 'add', 'index.html');
	shGit(upstream, 'commit', '-q', '-m', 'other');
	const other = shGit(upstream, 'rev-parse', 'HEAD');
	const clone = join(f.paths.appsDir, BOARD);
	shGit(clone, 'fetch', '-q', 'origin');
	shGit(clone, 'update-ref', `refs/epicenter/builds/${first}`, other);
	await rm(join(builds, first), { recursive: true });

	expect((await open(f.paths, BOARD, first)).state).toEqual({ kind: 'ready' });
	expect(await servedPage(f, BOARD)).toBe('<!doctype html><title>one</title>');
	expect(shGit(clone, 'cat-file', '-t', `refs/epicenter/builds/${first}`)).toBe(
		'tree',
	);
});

test("fetching writes only the default branch's tracking ref, whatever Git's global configuration maps", async () => {
	const f = await fixture();
	const { upstream, first } = await installedBoard(f);
	shGit(upstream, 'checkout', '-q', '-b', 'evil');
	await commitPage(upstream, 'EVIL', 'evil');
	shGit(upstream, 'checkout', '-q', 'main');
	const theirs = await commitPage(upstream, 'theirs', 'theirs');
	const clone = join(f.paths.appsDir, BOARD);
	const before = shGit(
		clone,
		'for-each-ref',
		'--format=%(refname) %(objecttype)',
	);

	const fetched = await withGlobalConfig(
		f,
		`[remote "origin"]\n\tfetch = +refs/heads/evil:refs/epicenter/builds/${first}\n\tfetch = +refs/heads/evil:HEAD\n`,
		() => update(f.paths, BOARD),
	);
	expect(pending(fetched).commit).toBe(theirs);
	expect(await headFile(f, BOARD)).toBe(first);
	expect(
		shGit(clone, 'for-each-ref', '--format=%(refname) %(objecttype)'),
	).toBe(before);
	expect(shGit(clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(theirs);
});

test("the installed clone keeps no ref but the tracking ref, whatever Git's global configuration maps", async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	await withGlobalConfig(
		f,
		'[remote "origin"]\n\tfetch = +refs/heads/*:refs/epicenter/builds/*\n',
		() => install(f.paths, upstream, ''),
	);
	expect(
		shGit(join(f.paths.appsDir, BOARD), 'for-each-ref', '--format=%(refname)'),
	).toBe('refs/remotes/origin/main');
});

test('a commit named at install without approving is refused, not ignored', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	const first = shGit(upstream, 'rev-parse', 'HEAD');
	await expect(
		install(f.paths, upstream, '', { commit: first }),
	).rejects.toThrow('--approve');
	expect(await readdir(f.paths.appsDir).catch(() => [])).toEqual([]);
});

test('approving names the commit a person saw, and never fetches one they did not', async () => {
	const f = await fixture();
	const upstream = await appRepository(f, 'board');
	await expect(
		install(f.paths, upstream, '', { approve: true }),
	).rejects.toThrow('--commit');
	expect(await readdir(f.paths.appsDir).catch(() => [])).toEqual([]);

	const first = shGit(upstream, 'rev-parse', 'HEAD');
	await install(f.paths, upstream, '', { approve: true, commit: first });
	await commitPage(upstream, 'unseen', 'unseen');
	await expect(update(f.paths, BOARD, { approve: true })).rejects.toThrow(
		'--commit',
	);
	const app = await inspect(f.paths, BOARD);
	expect(app.commit).toBe(first);
	// Nothing was fetched.
	expect(app.pending).toBeNull();
});

test('a failed build keeps the approval and serves nothing', async () => {
	const f = await fixture();
	const upstream = await appRepository(
		f,
		'board',
		BOARD_MANIFEST,
		'echo broken >&2; exit 3',
	);
	const first = shGit(upstream, 'rev-parse', 'HEAD');
	await install(f.paths, upstream, '');
	await expect(approve(f.paths, BOARD, first)).rejects.toThrow('did not build');
	expect(await headFile(f, BOARD)).toBe(first);
	const log = await readFile(
		join(f.paths.buildsDir, BOARD, `${first}.log`),
		'utf8',
	);
	expect(log).toContain('broken');
	expect((await inspect(f.paths, BOARD)).state).toEqual({ kind: 'unbuilt' });
	expect(await exists(join(f.paths.buildsDir, BOARD, first))).toBe(false);
	expect(await exists(join(f.paths.cacheDir, 'sources', BOARD))).toBe(false);
});

test("the build's source holds every file of its commit with each blob's bytes, whatever any attributes say", async () => {
	const f = await fixture();
	// The build copies the page and, when it is there, a file marked
	// export-ignore.
	const upstream = await appRepository(
		f,
		'board',
		BOARD_MANIFEST,
		`${BUILD} && cp extra.html dist/`,
	);
	const page = '<!doctype html>\n<title>$Id$</title>\n';
	await commitPage(upstream, page, 'expand nothing');
	await writeAt(upstream, 'extra.html', 'kept');
	// Committed after the page, so the page's blob keeps its bytes.
	await writeAt(
		upstream,
		'.gitattributes',
		'page.html text eol=crlf ident filter=inject\nextra.html export-ignore\n',
	);
	shGit(upstream, 'add', '.gitattributes', 'extra.html');
	shGit(upstream, 'commit', '-q', '-m', 'attributes');
	const waiting = await install(f.paths, upstream, '');

	// A smudge filter in the clone's config, a line of the person's own in
	// its attributes, and a replace ref that swaps the commit for another.
	const clone = join(f.paths.appsDir, BOARD);
	shGit(clone, 'config', 'filter.inject.smudge', 'sed s/title/INJECTED/');
	shGit(clone, 'config', 'filter.inject.required', 'true');
	await writeFile(join(clone, 'info/attributes'), '*.lockb diff=lockb\n');
	const commit = pending(waiting).commit;
	shGit(clone, 'replace', commit, shGit(clone, 'rev-parse', `${commit}~1`));

	expect((await approve(f.paths, BOARD, commit)).state).toEqual({
		kind: 'ready',
	});
	expect(await servedPage(f, BOARD)).toBe(page);
	expect(
		await readFile(
			join(f.paths.buildsDir, BOARD, commit, 'extra.html'),
			'utf8',
		),
	).toBe('kept');
	expect(await readFile(join(clone, 'info/attributes'), 'utf8')).toBe(
		`*.lockb diff=lockb\n${NEUTRAL_ATTRIBUTES}\n`,
	);
});

// ============================================================================
// Opening checks the build against its commit
// ============================================================================

test('opening reports a damaged build, and restores it in place only when asked to', async () => {
	const f = await fixture();
	const { first, builds } = await installedBoard(f);
	const build = join(builds, first);
	const original = '<!doctype html><title>one</title>';

	for (const damage of [
		() => writeFile(join(build, 'index.html'), 'edited'),
		() => writeFile(join(build, 'extra.js'), 'added'),
		() => rm(join(build, 'index.html')),
	]) {
		await damage();
		// A window may be running it, so nothing is written.
		const opened = await open(f.paths, BOARD, first);
		expect(opened.state).toEqual({ kind: 'damaged' });
		expect((await readdir(builds)).sort()).toEqual(
			[first, `${first}.log`].sort(),
		);
		// No window runs it: the build is extracted again, checked, and swapped in.
		expect((await openRestoring(f.paths, BOARD, first)).state).toEqual({
			kind: 'ready',
		});
		expect(await readdir(build)).toEqual(['index.html']);
		expect(await readFile(join(build, 'index.html'), 'utf8')).toBe(original);
		expect((await readdir(builds)).sort()).toEqual(
			[first, `${first}.log`].sort(),
		);
	}
});

test('the check ignores a .DS_Store, and refuses a linked build folder', async () => {
	const f = await fixture();
	const { first, builds } = await installedBoard(f);
	await writeFile(join(builds, first, '.DS_Store'), 'Finder');
	expect((await open(f.paths, BOARD, first)).state).toEqual({ kind: 'ready' });

	const elsewhere = join(f.root, 'elsewhere');
	await rename(builds, elsewhere);
	await symlink(elsewhere, builds);
	await expect(open(f.paths, BOARD, first)).rejects.toThrow('symbolic link');
});

test('opening reads no review of a commit waiting for approval', async () => {
	const f = await fixture();
	const { upstream, first } = await installedBoard(f);
	await commitPage(upstream, 'theirs', 'theirs');
	expect(pending(await update(f.paths, BOARD))).toBeDefined();
	const opened = await open(f.paths, BOARD, first);
	expect(opened.state).toEqual({ kind: 'ready' });
	expect(opened.pending).toBeNull();
});

test('a build whose dist holds a link fails', async () => {
	const f = await fixture();
	const upstream = await appRepository(
		f,
		'board',
		BOARD_MANIFEST,
		`${BUILD} && ln -s index.html dist/alias.html`,
	);
	const first = shGit(upstream, 'rev-parse', 'HEAD');
	await install(f.paths, upstream, '');
	await expect(approve(f.paths, BOARD, first)).rejects.toThrow('alias.html');
	expect((await inspect(f.paths, BOARD)).state).toEqual({ kind: 'unbuilt' });
});

test('a missing build directory is extracted from its build tree without building again', async () => {
	const f = await fixture();
	const { first, builds } = await installedBoard(f);
	await writeFile(join(builds, `${first}.log`), 'the first build');
	await rm(join(builds, first), { recursive: true });
	expect((await inspect(f.paths, BOARD)).state).toEqual({ kind: 'unbuilt' });

	expect((await open(f.paths, BOARD, first)).state).toEqual({ kind: 'ready' });
	expect(await servedPage(f, BOARD)).toBe('<!doctype html><title>one</title>');
	expect(await readFile(join(builds, `${first}.log`), 'utf8')).toBe(
		'the first build',
	);
	expect((await readdir(builds)).sort()).toEqual(
		[first, `${first}.log`].sort(),
	);
});

test('opening an app whose build is intact answers while another build holds the lock', async () => {
	const f = await fixture();
	const { first, builds } = await installedBoard(f);
	const held = new Database(join(f.paths.cacheDir, 'apps.lock'), {
		create: true,
	});
	held.exec('BEGIN EXCLUSIVE');
	try {
		expect((await open(f.paths, BOARD, first)).state).toEqual({
			kind: 'ready',
		});
		// Anything that has to write still waits its turn.
		await writeFile(join(builds, first, 'index.html'), 'edited');
		await expect(openRestoring(f.paths, BOARD, first)).rejects.toThrow(
			'already installing',
		);
	} finally {
		held.exec('COMMIT');
		held.close();
	}
});

test('a copy left by work that did not finish is removed by the next', async () => {
	const f = await fixture();
	const { first, builds } = await installedBoard(f);
	await writeAt(builds, `.${first}-0123abcd/index.html`, 'partial');
	await writeAt(builds, `.${first}-0123abcd.tar`, 'partial');
	await writeAt(f.paths.cacheDir, `sources/${BOARD}/stray.txt`, 'left');
	await rm(join(builds, first), { recursive: true });
	expect((await open(f.paths, BOARD, first)).state).toEqual({ kind: 'ready' });
	expect(
		(await readdir(builds)).filter((name) => name.startsWith('.')),
	).toEqual([]);
});

// ============================================================================
// Listing, hooks, the lock, and removing
// ============================================================================

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
	const hooks = join(f.paths.appsDir, BOARD, 'hooks');
	await mkdir(hooks, { recursive: true });
	const marker = join(f.root, 'hook-ran');
	// Fetching and approving each update a ref.
	const hook = join(hooks, 'reference-transaction');
	await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
	await chmod(hook, 0o755);
	await commitPage(upstream, '<!doctype html><title>theirs</title>', 'theirs');
	const fetched = await update(f.paths, BOARD);
	await approve(f.paths, BOARD, pending(fetched).commit);
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

test('removing an app deletes its clone and keeps its builds', async () => {
	const f = await fixture();
	const { first, builds } = await installedBoard(f);
	await remove(f.paths, BOARD);
	expect(await exists(join(f.paths.appsDir, BOARD))).toBe(false);
	// A window may still be running the build.
	expect(await exists(join(builds, first, 'index.html'))).toBe(true);
	await expect(remove(f.paths, BOARD)).rejects.toThrow('No app');
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

	const waiting = await install(f.paths, mono, '/apps/board/');
	expect(waiting).toMatchObject({ id: BOARD, folder: 'apps/board' });
	expect(pending(waiting).commit).toBe(first);
	const clone = join(f.paths.appsDir, BOARD);
	expect(shGit(clone, 'config', '--local', '--get', FOLDER_KEY)).toBe(
		'apps/board',
	);
	// The whole repository is cloned.
	expect(
		shGit(clone, 'cat-file', '-t', 'origin/main:apps/notes/epicenter.app.json'),
	).toBe('blob');

	const ready = await approve(f.paths, BOARD, first);
	expect(ready).toMatchObject({
		folder: 'apps/board',
		state: { kind: 'ready' },
	});
	expect(await servedPage(f, BOARD)).toBe(
		'<!doctype html><title>board</title>',
	);
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
	const waiting = await install(f.paths, mono, 'apps/board');
	shGit(
		join(f.paths.appsDir, waiting.id),
		'config',
		'--local',
		FOLDER_KEY,
		'../../elsewhere',
	);
	const app = await inspect(f.paths, waiting.id);
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
	const waiting = installed.lines.at(-1)?.app as InstalledApp;
	expect(waiting.state.kind).toBe('needsApproval');

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
		pending(waiting).commit,
		'--approve',
		'--json',
		'--',
		BOARD,
	);
	expect(approved.exitCode).toBe(0);
	expect(approved.lines.map((line) => line.progress).filter(Boolean)).toContain(
		'Building Board…',
	);
	const ready = approved.lines.at(-1)?.app as InstalledApp;
	expect(ready.state).toEqual({ kind: 'ready' });
	// Opening asks for the approved commit and exits 0.
	const opened = run(
		f.env,
		'app',
		'update',
		'--commit',
		ready.commit,
		'--json',
		'--',
		BOARD,
	);
	expect(opened.exitCode).toBe(0);
	expect((opened.lines.at(-1)?.app as InstalledApp).state).toEqual({
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
	expect(text.stdout).toMatch(
		/epicenter app update com\.example\.notes --commit=[0-9a-f]{40} --approve/,
	);
	expect(run(f.env, 'app', 'remove', BOARD, '--json').lines).toEqual([
		{ removed: BOARD },
	]);
});

test('app update exits 0 for an approved app with an update waiting, and says how a damaged build is restored', async () => {
	const f = await fixture();
	const { upstream, first, builds } = await installedBoard(f);
	const theirs = await commitPage(upstream, 'theirs', 'theirs');

	const fetched = run(f.env, 'app', 'update', '--json', '--', BOARD);
	expect(fetched.exitCode).toBe(0);
	const app = fetched.lines.at(-1)?.app as InstalledApp;
	expect(app).toMatchObject({ commit: first, state: { kind: 'ready' } });
	expect(app.pending?.commit).toBe(theirs);

	await writeFile(join(builds, first, 'index.html'), 'edited');
	const damaged = run(
		f.env,
		'app',
		'update',
		'--commit',
		first,
		'--json',
		'--',
		BOARD,
	);
	expect(damaged.exitCode).toBe(0);
	expect((damaged.lines.at(-1)?.app as InstalledApp).state).toEqual({
		kind: 'damaged',
	});
	const text = run(f.env, 'app', 'update', '--commit', first, '--', BOARD);
	expect(text.exitCode).toBe(0);
	expect(text.stdout).toContain('Open it in Epicenter');
	// Neither run wrote anything.
	expect(await readFile(join(builds, first, 'index.html'), 'utf8')).toBe(
		'edited',
	);
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
						'--commit',
						shGit(source, 'rev-parse', 'HEAD'),
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
					// Dependencies were installed in the source, which is gone.
					expect(await exists(join(f.paths.cacheDir, 'sources', id))).toBe(
						false,
					);

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
