/**
 * Installed apps (ADR-0540, ADR-0552, ADR-0560, ADR-0588, ADR-0597): an app
 * is a folder holding `epicenter.app.json` in a Git repository, the
 * repository's root unless installing names another folder. The repository's
 * default branch is cloned bare into app data, the clone's detached `HEAD` is
 * the commit approved to run, and each approved commit is built on this
 * machine from that commit's files alone (`app-paths.ts` says where each
 * directory is).
 *
 * ```txt
 * apps/<app-id>/                                 a bare clone of the default branch, without tags
 * apps/<app-id>/HEAD                             detached: the approved commit; symbolic until one is approved
 * apps/<app-id>/config                           remote.origin.fetch = +refs/heads/<default>:refs/remotes/origin/<default>
 *                                                epicenter.folder = apps/todos (absent: the root)
 * apps/<app-id>/info/attributes                  NEUTRAL_ATTRIBUTES: no attribute changes a byte
 * apps/<app-id>/refs/epicenter/builds/<commit>   the tree of that commit's build
 * sources/<app-id>/                              `git archive` of the approved commit, only while it builds
 * builds/<app-id>/<commit>/                      `git archive` of that commit's build tree
 * builds/<app-id>/<commit>.log                   what the install and build printed
 * ```
 *
 * Everything about an installed app is read from its clone: the folder from
 * `epicenter.folder`, the source from `origin`, the approved commit from
 * `HEAD`, and the commit waiting for approval from
 * `refs/remotes/origin/<default>`. Fetching writes only that ref, and only
 * approving moves `HEAD` (`git update-ref --no-deref`); `git pull` and
 * `git merge` refuse to run in a bare repository. A clone whose `HEAD` is
 * still symbolic has no approved commit and opens nothing.
 *
 * Builds run from source until publishing builds them (ADR-0589). The
 * approved commit is extracted with `git archive` into `sources/`, so nothing
 * but that commit reaches the build; `bun install` runs at its root, where the
 * lockfile is, so workspace packages resolve, and `bun run build:installed`
 * runs in the app's folder and writes `dist/`. Those files are written into
 * the clone as a tree, `refs/epicenter/builds/<commit>`, and the build
 * directory is a `git archive` of that tree. Opening an app (`update` with
 * `commit`) compares the build directory with the tree by path and blob hash;
 * a damaged build is extracted again into a fresh sibling, which the shell
 * swaps in when no window runs that commit. A window keeps the build it opened
 * on, so old builds stay, even after the app is removed.
 *
 * Approving trusts the app fully: its build runs with the person's
 * permissions. Git still runs through `@epicenter/folder`'s runner (no hooks,
 * no fsmonitor, no prompt, and no inherited variable pointing Git elsewhere),
 * with the `ext` and `fd` transports refused and replace refs ignored. Each
 * clone's `info/attributes` unsets every attribute that changes bytes before
 * anything is extracted (`neutralizeAttributes`), so every archive holds the
 * commit's blobs exactly and drops no file. Trust covers code, never data.
 *
 * This module writes the clones and the builds. The clones are the only
 * record of what is installed and approved (ADR-0569, ADR-0597):
 * `epicenter app list` reads them, and `so.epicenter` keeps no row per app.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	unlink,
} from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { CONNECTIONS_FOLDER_ID } from '@epicenter/ai/connection-table';
import {
	createGitRunner,
	holdingFileLock,
	neutralizeAttributes,
	nodeDirectoryPrimitives,
	runGit as runSystemGit,
} from '@epicenter/folder/bun';
import type { AppPaths } from './app-paths.ts';

/** The file that makes the folder holding it an app. */
export const MANIFEST = 'epicenter.app.json';
/** The key in a clone's `config` naming the folder the app is in. */
export const FOLDER_KEY = 'epicenter.folder';
/** How many directories deep a repository's apps are looked for. */
const MAX_FOLDER_DEPTH = 4;
/** Folder names never searched for apps. */
const SKIPPED_FOLDERS = ['node_modules', '.git'];
/** The `package.json` script that builds an app, run in its folder. */
const BUILD_SCRIPT = 'build:installed';
/** The folder, within the app's folder, that the build writes and Epicenter keeps. */
const OUTPUT = 'dist';
/** The refs in a clone naming each built commit's build tree, by commit. */
const BUILD_REFS = 'refs/epicenter/builds';
/** The directory of the cache directory holding each app's source while it builds. */
const SOURCES = 'sources';

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_LOG_LINES = '50';

/** What a person is told before approving: approval runs the app's code. */
export const APPROVAL_STATEMENT =
	"Approving builds this app on this computer. Building runs the app's code with your permissions, so approve only code you trust.";

/** `epicenter.app.json`: what Epicenter reads before anything of the app runs (ADR-0560). */
export type Manifest = { id: string; title: string };

/** An installed app, as `epicenter app list --json` prints it. */
export type InstalledApp = {
	/** The app's id, which is also its directory under `apps/`. */
	id: string;
	title: string;
	/** Where it was installed from: the clone's `origin`. */
	source: string;
	/** The folder within the repository holding `epicenter.app.json`, or empty for the root. */
	folder: string;
	/** The approved commit, the clone's detached `HEAD`. Empty until one is approved, and when the app is broken. */
	commit: string;
	state: AppState;
	/** The fetched commit of the default branch, when it is not the approved one: it runs only once approved. */
	pending: Review | null;
};

/** Whether an installed app can run. */
export type AppState =
	/** Its approved commit is built; it opens at once. */
	| { kind: 'ready' }
	/** Its commit is approved but not built, as after a build that failed; opening builds it. */
	| { kind: 'unbuilt' }
	/**
	 * Opening found the build directory differs from the commit's build.
	 * `repaired` names a fresh copy beside it in `builds/<id>/`, which the
	 * shell swaps in when no window runs that commit.
	 */
	| { kind: 'damaged'; repaired: string }
	/** No commit is approved, so nothing runs until `pending` is approved. */
	| { kind: 'needsApproval' }
	/** It cannot run as it is. */
	| { kind: 'broken'; problem: string };

/** What a person is shown before approving a commit. */
export type Review = {
	/** The commit approving runs. */
	commit: string;
	/** The commit approved now, when there is one. */
	from: string | null;
	/** `git log --oneline` of what would newly run. */
	log: string;
	/** `git diff --stat` from the approved commit, empty on a first install. */
	diffStat: string;
	statement: string;
};

/** One app found in a repository, as `epicenter app list --repository` prints it. */
export type RepositoryApp = {
	/** The folder holding `epicenter.app.json`, or empty for the root. */
	folder: string;
	/** The manifest's id, or empty when the manifest could not be read. */
	id: string;
	/** The manifest's title, or empty when the manifest could not be read. */
	title: string;
	/** Why this app cannot be installed, if it cannot: its manifest is not valid. */
	problem: string | null;
	/** Whether an app with this id is already installed. */
	installed: boolean;
};

/** A sentence saying what a long step is doing, for a progress line. */
export type Progress = (message: string) => void;

// ---------------------------------------------------------------------------
// The manifest, ids, folders, and sources

/** Read and check `epicenter.app.json`'s text. */
export function parseManifest(text: string): Manifest {
	const invalid = (why: string) =>
		new Error(`${MANIFEST} is not a valid app manifest: ${why}`);
	let file: unknown;
	try {
		file = JSON.parse(text);
	} catch (cause) {
		throw invalid(cause instanceof Error ? cause.message : String(cause));
	}
	if (typeof file !== 'object' || file === null || Array.isArray(file))
		throw invalid('it must be a JSON object');
	for (const key of Object.keys(file))
		if (key !== 'id' && key !== 'title')
			throw invalid(`unknown field \`${key}\`, expected \`id\` or \`title\``);
	const { id, title } = file as Record<string, unknown>;
	for (const [name, value] of [
		['id', id],
		['title', title],
	] as const) {
		if (value === undefined) throw invalid(`missing field \`${name}\``);
		if (typeof value !== 'string')
			throw invalid(`\`${name}\` must be a string`);
	}
	const problem = appIdProblem(id as string);
	if (problem !== undefined)
		throw new Error(`${MANIFEST} names the id '${id}', which ${problem}`);
	const trimmed = (title as string).trim();
	if (
		trimmed === '' ||
		[...trimmed].length > 100 ||
		hasControlCharacter(trimmed)
	)
		throw new Error(
			`${MANIFEST} needs a title of 1 to 100 characters on one line`,
		);
	return { id: id as string, title: trimmed };
}

/** Whether `text` holds a control character (Unicode category Cc). */
function hasControlCharacter(text: string) {
	for (const character of text) {
		const code = character.codePointAt(0) as number;
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/**
 * Why `id` cannot name an installed app, if it cannot: it must be a
 * lowercase reverse-domain name, such as `com.example.board`, and must not be
 * Epicenter's own (ADR-0552).
 */
export function appIdProblem(id: string): string | undefined {
	const labels = id.split('.');
	const wellFormed =
		id.length <= 128 &&
		labels.length >= 2 &&
		labels.every(
			(label) =>
				label.length >= 1 &&
				label.length <= 63 &&
				/^[a-z0-9-]+$/.test(label) &&
				!label.startsWith('-') &&
				!label.endsWith('-'),
		) &&
		/^[a-z]/.test(id);
	if (!wellFormed)
		return 'is not a lowercase reverse-domain name such as com.example.board';
	// Epicenter's own folder id, which no app may take (ADR-0552).
	if (id === CONNECTIONS_FOLDER_ID) return 'belongs to Epicenter itself';
	return undefined;
}

/**
 * `folder`, a folder within a repository, as the clone records it: its names
 * joined by `/`, or empty for the repository's root. Refuses `..`, an
 * absolute path, and anything in `.git` or `node_modules`.
 */
export function normalizeFolder(folder: string): string {
	const trimmed = folder.trim().replace(/^\/+|\/+$/g, '');
	if (trimmed === '' || trimmed === '.') return '';
	if (trimmed.includes('\0') || isAbsolute(trimmed))
		throw new Error(
			`The folder '${trimmed}' must be a path inside the repository.`,
		);
	const names = trimmed
		.split('/')
		.filter((name) => name !== '' && name !== '.');
	if (names.includes('..'))
		throw new Error(
			`The folder '${trimmed}' must be a path inside the repository, not in .git.`,
		);
	if (names.some((name) => SKIPPED_FOLDERS.includes(name)))
		throw new Error(`The folder '${trimmed}' is inside node_modules or .git.`);
	return names.join('/');
}

/**
 * Why `source` cannot be cloned, if it cannot: it must be an absolute local
 * path, an `https`, `http`, `ssh`, `git`, or `file` URL, or `user@host:path`.
 */
export function sourceProblem(source: string): string | undefined {
	if (source === '' || source.startsWith('-') || hasControlCharacter(source))
		return 'is not a Git URL or a local path';
	if (isAbsolute(source)) return undefined;
	const scheme = source.indexOf('://');
	if (scheme !== -1)
		return ['https', 'http', 'ssh', 'git', 'file'].includes(
			source.slice(0, scheme),
		)
			? undefined
			: 'uses a transport Epicenter does not clone from';
	if (source.includes('::'))
		return 'uses a transport Epicenter does not clone from';
	const colon = source.indexOf(':');
	const host = colon === -1 ? '' : source.slice(0, colon);
	const scpLike =
		colon !== -1 &&
		host !== '' &&
		!host.includes('/') &&
		source.slice(colon + 1) !== '';
	return scpLike ? undefined : 'is not a Git URL or an absolute local path';
}

/** The app folder of a tracked `path`, when it is an `epicenter.app.json` searched for. */
export function manifestFolder(path: string): string | undefined {
	const names = path.split('/');
	if (names.pop() !== MANIFEST || names.length > MAX_FOLDER_DEPTH)
		return undefined;
	if (names.some((name) => SKIPPED_FOLDERS.includes(name))) return undefined;
	return names.join('/');
}

// ---------------------------------------------------------------------------
// Git and other programs

const decoder = new TextDecoder();

function randomSuffix() {
	return randomBytes(8).toString('hex');
}

type GitOptions = {
	input?: string;
	env?: Readonly<Record<string, string>>;
};

/**
 * Run `git` on the bare clone at `clone` through `@epicenter/folder`'s
 * runner and return stdout, trimmed. The clone is named with `--git-dir`, so
 * Git never has to discover a bare repository, which a person's
 * `safe.bareRepository=explicit` refuses, and replace refs are ignored, so
 * every command reads the commits' own history.
 */
async function git(
	clone: string,
	args: readonly string[],
	options: GitOptions = {},
): Promise<string> {
	const { code, stdout } = await runGit(clone, args, options, false);
	if (code !== 0)
		throw new Error(`git ${subcommand(args)} exited with ${code}`);
	return decoder.decode(stdout).trim();
}

/** The subcommand `args` runs, past any `-c <name>=<value>` and global options. */
function subcommand(args: readonly string[]) {
	for (let index = 0; index < args.length; index++) {
		if (args[index] === '-c') index++;
		else if (!args[index]?.startsWith('-')) return args[index];
	}
	return args[0];
}

/** Whether `git` on the clone at `clone` succeeds. */
async function gitSucceeds(clone: string, args: readonly string[]) {
	return (await runGit(clone, args, {}, true)).code === 0;
}

async function runGit(
	clone: string,
	args: readonly string[],
	options: GitOptions,
	allowFailure: boolean,
) {
	return timed(args, (signal) =>
		createGitRunner(clone)(
			[`--git-dir=${clone}`, '--no-replace-objects', ...args],
			{ ...options, signal, allowFailure },
		),
	);
}

/** Run `work` under the Git timeout, saying which command it stopped. */
async function timed<T>(
	args: readonly string[],
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const signal = AbortSignal.timeout(GIT_TIMEOUT_MS);
	try {
		return await work(signal);
	} catch (cause) {
		if (signal.aborted)
			throw new Error(
				`git ${subcommand(args)} did not finish within ${GIT_TIMEOUT_MS / 60_000} minutes and was stopped`,
			);
		throw cause;
	}
}

/** The object `revision` names in the clone at `clone`, when it names one. */
async function objectAt(clone: string, revision: string) {
	const { code, stdout } = await runGit(
		clone,
		['rev-parse', '--verify', '-q', revision],
		{},
		true,
	);
	return code === 0 ? decoder.decode(stdout).trim() : undefined;
}

/** The commit `revision` names in the clone at `clone`, when it names one. */
function commitAt(clone: string, revision: string) {
	return objectAt(clone, `${revision}^{commit}`);
}

/**
 * Extract `treeish` from the clone at `clone` into `dir`, which must not
 * exist: `git archive` into a file beside it, unpacked with `tar`. The
 * clone's `info/attributes` is written first, so a person's edit of it cannot
 * let a filter, a line-ending conversion, or `export-ignore` change what is
 * extracted.
 */
async function extract(clone: string, treeish: string, dir: string) {
	const archive = `${dir}.tar`;
	try {
		await neutralizeAttributes(nodeDirectoryPrimitives, clone);
		await git(clone, [
			'archive',
			'--format=tar',
			`--output=${archive}`,
			treeish,
		]);
		await mkdir(dir, { recursive: true });
		await untar(archive, dir);
	} catch (cause) {
		await rm(dir, { recursive: true, force: true });
		throw cause;
	} finally {
		await rm(archive, { force: true });
	}
}

/** Unpack the tar file at `archive` into `dir`. */
function untar(archive: string, dir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('tar', ['-x', '-f', archive, '-C', dir], {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		let stderr = '';
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
		child.on('error', (cause) => {
			clearTimeout(timer);
			reject(new Error(`tar could not be started: ${cause.message}`));
		});
		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`tar exited with ${code === null ? `signal ${signal}` : `code ${code}`}: ${stderr.trim()}`,
					),
				);
		});
	});
}

/**
 * The environment of `bun` and the build: the binary running this command,
 * run as `bun` (`BUN_BE_BUN`), with a `bun` link to it heading `PATH` so the
 * build script's own `bun` finds the same binary (ADR-0556). From source,
 * the binary is already `bun`.
 */
async function buildEnvironment(cacheDir: string) {
	const env: Record<string, string | undefined> = {
		...process.env,
		BUN_BE_BUN: '1',
		CI: '1',
	};
	const shim = join(cacheDir, 'bin');
	const link = join(shim, 'bun');
	try {
		await mkdir(shim, { recursive: true });
		const existing = await readlink(link).catch(() => undefined);
		if (existing !== process.execPath) {
			await unlink(link).catch(() => {});
			await symlink(process.execPath, link);
		}
		env.PATH = env.PATH ? `${shim}${delimiter}${env.PATH}` : shim;
	} catch (cause) {
		process.stderr.write(
			`the bun link for app builds could not be made: ${String(cause)}\n`,
		);
	}
	return env;
}

/**
 * Run this binary as `bun` with `args` in `cwd`, its output appended to the
 * file open at `log`, killing it and what it started after the build
 * timeout.
 */
function runBun(
	args: readonly string[],
	cwd: string,
	env: Record<string, string | undefined>,
	log: number,
): Promise<void> {
	const what = `bun ${args.slice(0, 2).join(' ')}`;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			cwd,
			env,
			stdio: ['ignore', log, log],
			// Its own process group, so the timeout stops what it started too.
			detached: true,
		});
		const timer = setTimeout(() => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
				else child.kill('SIGKILL');
			} catch {}
			reject(
				new Error(
					`${what} did not finish within ${BUILD_TIMEOUT_MS / 60_000} minutes and was stopped`,
				),
			);
		}, BUILD_TIMEOUT_MS);
		child.on('error', (cause) => {
			clearTimeout(timer);
			reject(new Error(`${what} could not be started: ${cause.message}`));
		});
		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`${what} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`,
					),
				);
		});
	});
}

/**
 * One install, approval, update, build, or removal at a time on this
 * machine, so two never write the same clone, source, or build directory: an
 * exclusive SQLite transaction on `<cacheDir>/apps.lock`, which the system
 * releases if the process dies.
 */
function exclusively<T>(paths: AppPaths, work: () => Promise<T>) {
	return holdingFileLock(
		join(paths.cacheDir, 'apps.lock'),
		{
			waitMs: 0,
			held: 'Epicenter is already installing or building an app. Try again when it finishes.',
		},
		work,
	);
}

// ---------------------------------------------------------------------------
// Reading an installed app

async function kindOf(path: string) {
	return lstat(path).catch((cause: { code?: string }) => {
		if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return undefined;
		throw cause;
	});
}

/** The folder the clone at `clone` records as the app's, empty for the root. */
async function recordedFolder(clone: string) {
	const recorded = await git(clone, [
		'config',
		'--local',
		'--default',
		'',
		'--get',
		FOLDER_KEY,
	]);
	try {
		return normalizeFolder(recorded);
	} catch (cause) {
		throw new Error(
			`${FOLDER_KEY} in this app's clone is wrong: ${(cause as Error).message}`,
		);
	}
}

/**
 * `refs/remotes/origin/<default>`, the one ref fetching writes, read from the
 * clone's one refspec.
 */
async function trackingRef(clone: string) {
	const { stdout } = await runGit(
		clone,
		['config', '--local', '--get-all', 'remote.origin.fetch'],
		{},
		true,
	);
	const refspec = decoder.decode(stdout).trim();
	const match = /^\+refs\/heads\/(.+):refs\/remotes\/origin\/(.+)$/.exec(
		refspec,
	);
	if (match === null || match[1] !== match[2])
		throw new Error(
			"This app's clone does not fetch one branch. Remove the app and install it again.",
		);
	return `refs/remotes/origin/${match[2]}`;
}

/**
 * The approved commit: `HEAD` of the clone at `clone` when it is detached.
 * A symbolic `HEAD`, as a fresh clone has, approves nothing.
 */
async function approvedCommit(clone: string) {
	if (await gitSucceeds(clone, ['symbolic-ref', '-q', 'HEAD']))
		return undefined;
	return git(clone, ['rev-parse', '--verify', 'HEAD^{commit}']);
}

/** The mode, type, and object of `path` in `commit`, when it has that path. */
async function entryAt(clone: string, commit: string, path: string) {
	const listed = await git(clone, ['ls-tree', '-z', commit, '--', path]);
	const record = listed.split('\0')[0] ?? '';
	const tab = record.indexOf('\t');
	if (tab === -1 || record.slice(tab + 1) !== path) return undefined;
	const [mode, type, object] = record.slice(0, tab).split(' ');
	return { mode, type, object: object as string };
}

/**
 * The manifest in `folder` (empty for the root) at `commit`, read from the
 * clone's objects. A folder or manifest reached through a link is missing.
 */
async function manifestAt(
	clone: string,
	commit: string,
	folder: string,
): Promise<Manifest> {
	if (folder !== '' && (await entryAt(clone, commit, folder))?.type !== 'tree')
		throw new Error(`The repository has no folder ${folder}.`);
	const entry = await entryAt(
		clone,
		commit,
		folder === '' ? MANIFEST : `${folder}/${MANIFEST}`,
	);
	let text: string;
	try {
		if (entry === undefined) throw new Error('is missing');
		if (entry.type !== 'blob' || entry.mode === '120000')
			throw new Error('is not a regular file');
		const size = Number(await git(clone, ['cat-file', '-s', entry.object]));
		if (size > MAX_MANIFEST_BYTES)
			throw new Error(`is larger than ${MAX_MANIFEST_BYTES} bytes`);
		text = await git(clone, ['cat-file', 'blob', entry.object]);
	} catch (cause) {
		throw new Error(
			`${MANIFEST} ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	return parseManifest(text);
}

/** The tree of `commit`'s build, when the clone at `clone` records one. */
function buildTree(clone: string, commit: string) {
	return objectAt(clone, `${BUILD_REFS}/${commit}^{tree}`);
}

async function review(
	clone: string,
	approved: string | undefined,
	commit: string,
): Promise<Review> {
	const text = (args: readonly string[]) =>
		git(clone, args).catch((cause: Error) => cause.message);
	const logArgs = ['log', '--oneline', '--no-decorate', '-n', MAX_LOG_LINES];
	const [log, diffStat] =
		approved === undefined
			? [await text([...logArgs, commit]), '']
			: await Promise.all([
					text([...logArgs, `${approved}..${commit}`]),
					text(['diff', '--stat', approved, commit]),
				]);
	return {
		commit,
		from: approved ?? null,
		log,
		diffStat,
		statement: APPROVAL_STATEMENT,
	};
}

/** The installed app in `apps/<id>/`, as it is now. */
export async function inspect(
	paths: AppPaths,
	id: string,
): Promise<InstalledApp> {
	const clone = join(paths.appsDir, id);
	let folder = '';
	const broken = (title: string, problem: string): InstalledApp => ({
		id,
		title,
		source: '',
		folder,
		commit: '',
		state: { kind: 'broken', problem },
		pending: null,
	});
	let approved: string | undefined;
	let fetched: string | undefined;
	let manifest: Manifest;
	try {
		folder = await recordedFolder(clone);
		fetched = await commitAt(clone, await trackingRef(clone));
		approved = await approvedCommit(clone);
		const shown = approved ?? fetched;
		if (shown === undefined) throw new Error("This app's clone has no commit.");
		manifest = await manifestAt(clone, shown, folder);
	} catch (cause) {
		return broken(id, (cause as Error).message);
	}
	if (manifest.id !== id)
		return broken(
			manifest.title,
			`${MANIFEST} names the id '${manifest.id}', but the app is installed as ${id}`,
		);
	const pending =
		fetched !== undefined && fetched !== approved
			? await review(clone, approved, fetched)
			: null;
	let state: AppState;
	if (approved === undefined) state = { kind: 'needsApproval' };
	else if (
		(await buildTree(clone, approved)) !== undefined &&
		(await kindOf(join(paths.buildsDir, id, approved)))?.isDirectory()
	)
		state = { kind: 'ready' };
	else state = { kind: 'unbuilt' };
	const origin = await git(clone, [
		'config',
		'--get',
		'remote.origin.url',
	]).catch(() => '');
	return {
		id,
		title: manifest.title,
		source: origin,
		folder,
		commit: approved ?? '',
		state,
		pending,
	};
}

/** Every installed app, by id. */
export async function listInstalled(paths: AppPaths): Promise<InstalledApp[]> {
	const entries = await readdir(paths.appsDir, { withFileTypes: true }).catch(
		(cause: { code?: string }) => {
			if (cause.code === 'ENOENT') return [];
			throw new Error(`The installed apps could not be read: ${String(cause)}`);
		},
	);
	const ids = entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.sort();
	return Promise.all(ids.map((id) => inspect(paths, id)));
}

// ---------------------------------------------------------------------------
// Listing a repository, installing, approving, updating, removing

/**
 * Clone `source` bare into a dot directory of `apps/`, which no listing
 * reads, and run `work` on the clone. The clone is removed unless `work`
 * moved it. Its attributes change no bytes (`neutralizeAttributes`) before
 * anything reads it.
 */
async function withStagedClone<T>(
	paths: AppPaths,
	source: string,
	cloneArgs: readonly string[],
	work: (clone: string) => Promise<T>,
): Promise<T> {
	const problem = sourceProblem(source);
	if (problem !== undefined) throw new Error(`'${source}' ${problem}.`);
	await mkdir(paths.appsDir, { recursive: true }).catch((cause) => {
		throw new Error(
			`The installed apps' directory could not be made: ${String(cause)}`,
		);
	});
	const staging = join(paths.appsDir, `.installing-${randomSuffix()}`);
	const args = [
		'clone',
		'--bare',
		'--no-recurse-submodules',
		'--template=',
		...cloneArgs,
		'--',
		source,
		staging,
	];
	try {
		await timed(args, (signal) =>
			runSystemGit(args, { cwd: paths.appsDir, signal }),
		);
		await neutralizeAttributes(nodeDirectoryPrimitives, staging);
		return await work(staging);
	} finally {
		// A rename moved it into place; otherwise nothing of it is kept.
		await rm(staging, { recursive: true, force: true });
	}
}

/**
 * The apps in the repository at `source`: each folder, within four
 * directories and outside `node_modules`, holding a tracked
 * `epicenter.app.json`. The clone it reads is shallow, fetches only the
 * manifests' contents, and is removed after.
 */
export async function listRepository(
	paths: AppPaths,
	source: string,
): Promise<RepositoryApp[]> {
	return exclusively(paths, () =>
		withStagedClone(
			paths,
			source.trim(),
			['--depth=1', '--filter=blob:none'],
			async (clone) => {
				const tracked = await git(clone, [
					'ls-tree',
					'-r',
					'-z',
					'--name-only',
					'HEAD',
				]);
				const apps: RepositoryApp[] = [];
				for (const path of tracked.split('\0')) {
					const folder = manifestFolder(path);
					if (folder === undefined) continue;
					try {
						const manifest = await manifestAt(clone, 'HEAD', folder);
						apps.push({
							folder,
							id: manifest.id,
							title: manifest.title,
							problem: null,
							installed:
								(await kindOf(join(paths.appsDir, manifest.id))) !== undefined,
						});
					} catch (cause) {
						apps.push({
							folder,
							id: '',
							title: '',
							problem: (cause as Error).message,
							installed: false,
						});
					}
				}
				return apps.sort((a, b) =>
					a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0,
				);
			},
		),
	);
}

type SettleOptions = {
	/** Approve the commit waiting for approval, or `commit`, then build it. */
	approve?: boolean;
	/** The commit a person was shown: refuse unless it is the one acted on. */
	commit?: string;
	onProgress?: Progress;
};

/**
 * Clone `source`'s default branch bare into `apps/<id>/`, the id read from
 * the manifest in `folder` (empty for the root), and record `folder` in the
 * clone's `config`. The clone fetches only that branch: `--single-branch
 * --no-tags` writes no refspec, so the refspec for
 * `refs/remotes/origin/<default>` is written and fetched once. Its `HEAD`
 * stays symbolic, approving nothing, unless `approve` approves the fetched
 * commit and builds it.
 */
export async function install(
	paths: AppPaths,
	source: string,
	folder: string,
	options: SettleOptions = {},
): Promise<InstalledApp> {
	const from = source.trim();
	const normalized = normalizeFolder(folder);
	return exclusively(paths, async () => {
		options.onProgress?.(`Cloning ${from}…`);
		const id = await withStagedClone(
			paths,
			from,
			['--single-branch', '--no-tags'],
			async (staging) => {
				const head = await git(staging, ['symbolic-ref', '-q', 'HEAD']).catch(
					() => '',
				);
				if (
					!head.startsWith('refs/heads/') ||
					(await commitAt(staging, head)) === undefined
				)
					throw new Error(
						'The repository has no commit on its default branch.',
					);
				const branch = head.slice('refs/heads/'.length);
				const tracking = `refs/remotes/origin/${branch}`;
				await git(staging, [
					'config',
					'--local',
					'remote.origin.fetch',
					`+${head}:${tracking}`,
				]);
				await git(staging, ['fetch', '--no-recurse-submodules', 'origin']);
				const fetched = await commitAt(staging, tracking);
				if (fetched === undefined)
					throw new Error(`Fetching ${branch} brought no commit.`);
				let manifest: Manifest;
				try {
					manifest = await manifestAt(staging, fetched, normalized);
				} catch (cause) {
					const problem = (cause as Error).message;
					throw new Error(
						normalized === '' || !problem.startsWith(MANIFEST)
							? problem
							: `${normalized}/${problem}`,
					);
				}
				if (normalized !== '')
					await git(staging, ['config', '--local', FOLDER_KEY, normalized]);
				const destination = join(paths.appsDir, manifest.id);
				if ((await kindOf(destination)) !== undefined)
					throw new Error(
						`An app with the id ${manifest.id} is already installed.`,
					);
				await rename(staging, destination).catch((cause) => {
					throw new Error(
						`The app could not be moved into place: ${String(cause)}`,
					);
				});
				return manifest.id;
			},
		);
		return settle(paths, id, options);
	});
}

/**
 * Act on app `id`. Without `commit`, fetch its default branch, which writes
 * `refs/remotes/origin/<default>` and never `HEAD`. With `approve`, approve
 * the commit waiting for approval, or `commit`, the one a person was shown.
 * Either way, build the approved commit when it is not built.
 *
 * With `commit` alone, open: answer for `commit` only when it is the
 * approved commit, building it when it is not built and checking its build
 * directory against its build tree when it is. A damaged build is reported
 * with a fresh copy beside it (`damaged`), never replaced here, since a window
 * may be running it.
 */
export async function update(
	paths: AppPaths,
	id: string,
	options: SettleOptions = {},
): Promise<InstalledApp> {
	if (options.commit !== undefined && !options.approve)
		return open(paths, id, options.commit, options.onProgress);
	return exclusively(paths, async () => {
		const clone = await installedClone(paths, id);
		if (options.commit === undefined) {
			options.onProgress?.('Fetching updates…');
			await git(clone, ['fetch', '--no-recurse-submodules', 'origin']);
		}
		return settle(paths, id, options);
	});
}

/**
 * Opening asks this for its commit every time. When that commit is approved
 * and its build is intact there is nothing to write, so it answers without
 * the lock and opens while another app installs or builds: every write it
 * could see is a rename or a ref update, so this unlocked read sees a whole
 * state.
 */
async function open(
	paths: AppPaths,
	id: string,
	commit: string,
	onProgress?: Progress,
): Promise<InstalledApp> {
	await installedClone(paths, id);
	const app = openable(await inspect(paths, id), commit);
	if (app.state.kind === 'needsApproval') return app;
	if (app.state.kind === 'ready' && (await buildIntact(paths, app))) return app;
	return exclusively(paths, async () => {
		const locked = openable(await inspect(paths, id), commit);
		if (locked.state.kind === 'needsApproval') return locked;
		return provided(paths, locked, onProgress);
	});
}

/** `app`, refused when it is broken or its approved commit is not `commit`. */
function openable(app: InstalledApp, commit: string) {
	if (app.state.kind === 'broken') throw new Error(app.state.problem);
	if (app.state.kind !== 'needsApproval' && app.commit !== commit)
		throw new Error(
			`${app.title} changed since it was shown. Review it again.`,
		);
	return app;
}

/**
 * Approve what `approve` names, then build app `id`'s approved commit when
 * it is not built; otherwise leave it as it is.
 */
async function settle(
	paths: AppPaths,
	id: string,
	{ approve = false, commit, onProgress }: SettleOptions,
): Promise<InstalledApp> {
	let app = await inspect(paths, id);
	if (app.state.kind === 'broken') throw new Error(app.state.problem);
	if (approve) {
		const target = commit ?? app.pending?.commit ?? app.commit;
		if (target !== app.commit) {
			if (target !== app.pending?.commit)
				throw new Error(
					`${app.title} changed since it was shown. Review it again.`,
				);
			await approveCommit(paths, app, target);
			app = await inspect(paths, id);
			if (app.state.kind === 'broken') throw new Error(app.state.problem);
		}
	}
	return app.state.kind === 'unbuilt' ? provided(paths, app, onProgress) : app;
}

/**
 * Detach `HEAD` of `app`'s clone at `commit`: `git update-ref --no-deref`,
 * the one write that moves it. A commit whose manifest names another id is
 * refused, so `HEAD` never names a commit that is not this app.
 */
async function approveCommit(
	paths: AppPaths,
	app: InstalledApp,
	commit: string,
) {
	const clone = join(paths.appsDir, app.id);
	const manifest = await manifestAt(clone, commit, app.folder).catch(
		(cause: Error) => {
			throw new Error(`${app.title} cannot be approved: ${cause.message}`);
		},
	);
	if (manifest.id !== app.id)
		throw new Error(
			`${app.title} cannot be approved: at this commit ${MANIFEST} names the id '${manifest.id}'.`,
		);
	await git(clone, ['update-ref', '--no-deref', 'HEAD', commit]);
}

async function installedClone(paths: AppPaths, id: string) {
	const problem = appIdProblem(id);
	if (problem !== undefined) throw new Error(`'${id}' ${problem}.`);
	const clone = join(paths.appsDir, id);
	if (!(await kindOf(clone))?.isDirectory())
		throw new Error(`No app with the id ${id} is installed.`);
	return clone;
}

/**
 * Remove app `id`: its clone, which holds nothing its remote lacks. Its
 * builds stay, since a window may still be running one (removing them is
 * later work).
 */
export async function remove(paths: AppPaths, id: string): Promise<void> {
	return exclusively(paths, async () => {
		const clone = await installedClone(paths, id);
		await rm(clone, { recursive: true, force: true });
		await rm(join(paths.cacheDir, SOURCES, id), {
			recursive: true,
			force: true,
		});
	});
}

// ---------------------------------------------------------------------------
// Building and checking a build

/** Whether `app`'s build directory holds exactly its approved commit's build tree. */
async function buildIntact(paths: AppPaths, app: InstalledApp) {
	const clone = join(paths.appsDir, app.id);
	const tree = await buildTree(clone, app.commit);
	return (
		tree !== undefined &&
		matchesTree(clone, join(paths.buildsDir, app.id, app.commit), tree)
	);
}

/** `app` once its approved commit's build is provided (`provide`). */
async function provided(
	paths: AppPaths,
	app: InstalledApp,
	onProgress?: Progress,
): Promise<InstalledApp> {
	const repaired = await provide(paths, app, onProgress);
	return repaired === undefined
		? inspect(paths, app.id)
		: { ...app, state: { kind: 'damaged', repaired } };
}

/**
 * Make `builds/<id>/<commit>/` the approved commit's build. The commit is
 * built from source first when the clone records no build tree for it
 * (`build`). A missing build directory is extracted from the tree into a
 * sibling and renamed into place. One already there is checked against the
 * tree (`matchesTree`); a damaged one is left in place, since a window may be
 * running it, and a fresh copy is extracted beside it, whose name this
 * returns.
 */
async function provide(
	paths: AppPaths,
	app: InstalledApp,
	onProgress?: Progress,
): Promise<string | undefined> {
	const clone = join(paths.appsDir, app.id);
	const builds = join(paths.buildsDir, app.id);
	await mkdir(builds, { recursive: true }).catch((cause) => {
		throw new Error(`The build folder could not be made: ${String(cause)}`);
	});
	// One build runs at a time (`exclusively`), so a dot entry in the build
	// folder (a copy, an archive, an index, or a fresh copy the shell did not
	// swap in) was left by work that did not finish.
	try {
		for (const name of await readdir(builds))
			if (name.startsWith('.'))
				await rm(join(builds, name), { recursive: true, force: true });
	} catch (cause) {
		throw new Error(
			`A copy left in ${builds} by an earlier build could not be removed: ${String(cause)}. Delete it and try again.`,
		);
	}
	const tree =
		(await buildTree(clone, app.commit)) ??
		(await build(paths, app, onProgress));
	const destination = join(builds, app.commit);
	const present = (await kindOf(destination)) !== undefined;
	if (present && (await matchesTree(clone, destination, tree)))
		return undefined;
	onProgress?.(present ? 'Restoring the build…' : 'Keeping the build…');
	const fresh = join(builds, `.${app.commit}-${randomSuffix()}`);
	await extract(clone, tree, fresh).catch((cause: Error) => {
		throw new Error(
			`${app.title}'s build could not be extracted: ${cause.message}`,
		);
	});
	if (present) return basename(fresh);
	await rename(fresh, destination).catch(async (cause) => {
		await rm(fresh, { recursive: true, force: true });
		throw new Error(`${app.title}'s build could not be kept: ${String(cause)}`);
	});
	return undefined;
}

/**
 * Build `app`'s approved commit from source and record its files in the
 * clone as `refs/epicenter/builds/<commit>`, returning that tree. The commit
 * is extracted with `git archive` into `sources/<id>/`, `bun install` runs at
 * its root and `bun run build:installed` in the app's folder, and the
 * regular files of its `dist/` are written into the clone (`recordTree`).
 * The source is removed after. What both print goes to
 * `builds/<id>/<commit>.log`.
 */
async function build(
	paths: AppPaths,
	app: InstalledApp,
	onProgress?: Progress,
): Promise<string> {
	const clone = join(paths.appsDir, app.id);
	const builds = join(paths.buildsDir, app.id);
	const logPath = join(builds, `${app.commit}.log`);
	const failed = (problem: string) =>
		new Error(`${app.title} did not build: ${problem}. See ${logPath}`);
	const sources = join(paths.cacheDir, SOURCES, app.id);
	try {
		await rm(sources, { recursive: true, force: true });
		await mkdir(dirname(sources), { recursive: true });
	} catch (cause) {
		throw new Error(
			`${sources} is left from an earlier build and could not be removed: ${String(cause)}. Delete it and try again.`,
		);
	}
	try {
		onProgress?.('Extracting the commit…');
		await extract(clone, app.commit, sources).catch((cause: Error) => {
			throw new Error(
				`${app.title} did not build: commit ${app.commit} could not be extracted (${cause.message}).`,
			);
		});
		// `inspect` read the manifest at this commit, so the folder is a
		// directory of it, never a link.
		const dir = app.folder === '' ? sources : join(sources, app.folder);
		const env = await buildEnvironment(paths.cacheDir);
		const log = openSync(logPath, 'w');
		try {
			if ((await kindOf(join(sources, 'package.json')))?.isFile()) {
				onProgress?.('Installing dependencies…');
				await runBun(
					['install', '--frozen-lockfile', '--ignore-scripts'],
					sources,
					env,
					log,
				);
			}
			onProgress?.(`Building ${app.title}…`);
			await runBun(['run', BUILD_SCRIPT], dir, env, log);
		} catch (cause) {
			throw failed((cause as Error).message);
		} finally {
			closeSync(log);
		}

		const root = await realpath(dir);
		const output = await realpath(join(dir, OUTPUT)).catch(() => {
			throw failed(`it wrote no ${OUTPUT}`);
		});
		const page = await stat(join(output, 'index.html')).catch(() => undefined);
		if (!output.startsWith(root + sep) || !page?.isFile())
			throw failed(
				`${OUTPUT} must be a folder in the app's folder holding index.html`,
			);
		return await recordTree(clone, app.commit, output, builds).catch(
			(cause) => {
				throw failed(`the build could not be kept: ${String(cause)}`);
			},
		);
	} finally {
		// Best effort: the build's own outcome is the result.
		await rm(sources, { recursive: true, force: true }).catch((cause) => {
			process.stderr.write(
				`the source ${sources} could not be removed: ${String(cause)}\n`,
			);
		});
	}
}

/**
 * Write the regular files under `output` into the clone at `clone` as one
 * tree, name it `refs/epicenter/builds/<commit>`, and return it. Links are
 * left out. The index the tree is written from is a dot file in `scratch`,
 * removed after.
 */
async function recordTree(
	clone: string,
	commit: string,
	output: string,
	scratch: string,
) {
	const files: string[] = [];
	await listFiles(output, '', files);
	if (files.some((path) => path.includes('\n')))
		throw new Error('a file name in the build holds a line break');
	const objects = (
		await git(clone, ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
			input: `${files.map((path) => join(output, path)).join('\n')}\n`,
		})
	).split('\n');
	const index = join(scratch, `.index-${randomSuffix()}`);
	try {
		const env = { GIT_INDEX_FILE: index };
		await git(clone, ['update-index', '--add', '-z', '--index-info'], {
			env,
			input: files
				.map((path, at) => `100644 ${objects[at]}\t${path}\0`)
				.join(''),
		});
		const tree = await git(clone, ['write-tree'], { env });
		await git(clone, ['update-ref', `${BUILD_REFS}/${commit}`, tree]);
		return tree;
	} finally {
		await rm(index, { force: true });
	}
}

/** Add the path of each regular file under `root`/`relative` to `files`; links are left out. */
async function listFiles(root: string, relative: string, files: string[]) {
	for (const entry of await readdir(join(root, relative), {
		withFileTypes: true,
	})) {
		const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
		if (entry.isDirectory()) await listFiles(root, path, files);
		else if (entry.isFile()) files.push(path);
	}
}

/**
 * Whether `dir` holds exactly `tree`: each of its paths with its blob's
 * bytes, a link where the tree has one, and no other file or link. Folders
 * are not compared, since an empty one serves nothing. A check that cannot
 * finish answers no.
 */
async function matchesTree(clone: string, dir: string, tree: string) {
	try {
		const format = await git(clone, ['rev-parse', '--show-object-format']);
		const expected = new Map<string, string>();
		const listed = await git(clone, [
			'ls-tree',
			'-r',
			'-z',
			'--full-tree',
			tree,
		]);
		for (const record of listed.split('\0')) {
			const tab = record.indexOf('\t');
			if (tab === -1) continue;
			const [mode, type, object] = record.slice(0, tab).split(' ');
			// A submodule's commit extracts as an empty folder.
			if (type !== 'blob') continue;
			expected.set(
				record.slice(tab + 1),
				`${mode === '120000' ? 'link' : 'file'} ${object}`,
			);
		}
		const found = new Map<string, string>();
		await hashEntries(dir, '', format, found);
		return (
			found.size === expected.size &&
			[...expected].every(([path, entry]) => found.get(path) === entry)
		);
	} catch {
		return false;
	}
}

/** Add each file and link under `root`/`relative` to `found`, with its blob id. */
async function hashEntries(
	root: string,
	relative: string,
	format: string,
	found: Map<string, string>,
) {
	for (const entry of await readdir(join(root, relative), {
		withFileTypes: true,
	})) {
		const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
		const full = join(root, path);
		if (entry.isDirectory()) await hashEntries(root, path, format, found);
		else if (entry.isFile())
			found.set(path, `file ${blobId(format, await readFile(full))}`);
		else if (entry.isSymbolicLink())
			found.set(
				path,
				`link ${blobId(format, await readlink(full, { encoding: 'buffer' }))}`,
			);
		else found.set(path, 'other');
	}
}

/** The id Git gives a blob of `bytes` in a repository of object format `format`. */
function blobId(format: string, bytes: Uint8Array) {
	return createHash(format === 'sha256' ? 'sha256' : 'sha1')
		.update(`blob ${bytes.byteLength}\0`)
		.update(bytes)
		.digest('hex');
}
