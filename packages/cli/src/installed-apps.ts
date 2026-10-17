/**
 * Installed apps (ADR-0540, ADR-0552, ADR-0560, ADR-0588): an app is a folder
 * holding `epicenter.app.json` in a Git repository, the repository's root
 * unless installing names another folder. The repository is cloned into
 * `Apps/<app-id>/`, and each approved commit is built on this machine from a
 * checkout of that commit alone (`app-paths.ts` says where each directory
 * is).
 *
 * ```txt
 * Apps/<app-id>/                       a full clone of the repository
 * Apps/<app-id>/.git/config            epicenter.folder = apps/todos (absent: the root)
 * approvals.json                       { [appId]: { commit, approvedAt } }
 * checkouts/<app-id>/                  a detached worktree of the commit, only while it builds
 * builds/<app-id>/<commit>/            the built bundle, never replaced once finished
 * builds/<app-id>/<commit>.built       written once that build finished
 * builds/<app-id>/<commit>.log         what the install and build printed
 * builds/<app-id>/current              the commit a newly opened app window loads
 * ```
 *
 * Everything about an installed app is read from its clone: the folder from
 * `epicenter.folder`, the source from `origin`, and the commit from `HEAD`.
 * The build never runs in the clone, so nothing uncommitted, untracked, or
 * ignored there reaches it: `git worktree add --detach` checks the commit out
 * under `checkouts/` (`checkOut`), `bun install` runs at that checkout's root, where the
 * lockfile is, so workspace packages resolve, and `bun run build:installed`
 * runs in the app's folder and writes `dist/`, which is kept. A window opened
 * on a build keeps it until the window is opened again, so a commit's build
 * directory is reused, never rebuilt over, and old builds stay, even after
 * the app is removed.
 *
 * Every commit that runs is approved first, including one made on this
 * machine: `HEAD` runs only when `approvals.json` names it.
 *
 * Approving trusts the app fully: its build runs with the person's
 * permissions. Git still runs through `@epicenter/folder`'s runner (no hooks,
 * no fsmonitor, no prompt, discovery stopped at the repository, and no
 * inherited variable pointing Git elsewhere), with the `ext` and `fd`
 * transports refused. Trust covers code, never data.
 *
 * This module writes the clones, `approvals.json`, and the builds. They are
 * the only record of what is installed (ADR-0569): `epicenter app list`
 * reads them, and `so.epicenter` keeps no row per app.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import {
	copyFile,
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
	writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { CONNECTIONS_FOLDER_ID } from '@epicenter/ai/connection-table';
import { createGitRunner, holdingFileLock } from '@epicenter/folder/bun';
import type { AppPaths } from './app-paths.ts';

/** The file that makes the folder holding it an app. */
export const MANIFEST = 'epicenter.app.json';
/** The key in a clone's `.git/config` naming the folder the app is in. */
export const FOLDER_KEY = 'epicenter.folder';
/** How many directories deep a repository's apps are looked for. */
const MAX_FOLDER_DEPTH = 4;
/** Folder names never searched for apps. */
const SKIPPED_FOLDERS = ['node_modules', '.git'];
/** The `package.json` script that builds an app, run in its folder. */
const BUILD_SCRIPT = 'build:installed';
/** The folder, within the app's folder, that the build writes and Epicenter keeps. */
const OUTPUT = 'dist';
/** The file in an app's build directory naming the commit a newly opened app window loads. */
const CURRENT_BUILD = 'current';
/** The directory of the cache directory holding each build's checkout while it builds. */
const CHECKOUTS = 'checkouts';
/** The suffix of the file beside `builds/<id>/<commit>/` saying that build finished. */
const BUILT_MARKER = '.built';

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
	/** The app's id, which is also its directory under `Apps/`. */
	id: string;
	title: string;
	/** Where it was installed from: the repository's `origin`, or empty when it has none. */
	source: string;
	/** The folder within the repository holding `epicenter.app.json`, or empty for the root. */
	folder: string;
	/** The commit checked out, `HEAD`. Empty when the app is broken. */
	commit: string;
	state: AppState;
};

/** Whether an installed app can run. */
export type AppState =
	/** Approved and built at its commit; it opens at once. */
	| { kind: 'ready' }
	/** Its commit is approved but is not the current build, as after a build that failed. */
	| { kind: 'unbuilt' }
	/** No one approved its commit on this machine, so it runs only once approved. */
	| { kind: 'needsApproval'; review: Review }
	/** It cannot run as it is. */
	| { kind: 'broken'; problem: string };

/** What a person is shown before approving a commit. */
export type Review = {
	/** The commit approved before, when this repository has it. */
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
	/** Whether an app with this id is already installed in `Apps/`. */
	installed: boolean;
};

/** One app approval, as `approvals.json` keeps it. */
export type Approval = {
	commit: string;
	/** Milliseconds since the Unix epoch. */
	approvedAt: number;
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
// Approvals

/**
 * `approvals.json`, or no approvals when it is missing. A file that cannot be
 * read as approvals approves nothing, so every app asks again.
 */
export async function readApprovals(
	file: string,
): Promise<Record<string, Approval>> {
	let text: string;
	try {
		text = await readFile(file, 'utf8');
	} catch (cause) {
		if ((cause as { code?: string }).code === 'ENOENT') return {};
		process.stderr.write(`${file} could not be read: ${String(cause)}\n`);
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
			throw new Error('it is not a JSON object');
		const approvals: Record<string, Approval> = {};
		for (const [id, value] of Object.entries(parsed)) {
			const entry = value as Record<string, unknown>;
			const keys = Object.keys(entry ?? {})
				.sort()
				.join(',');
			if (
				keys !== 'approvedAt,commit' ||
				typeof entry.commit !== 'string' ||
				typeof entry.approvedAt !== 'number'
			)
				throw new Error(`the entry for '${id}' is not { commit, approvedAt }`);
			approvals[id] = {
				commit: entry.commit,
				approvedAt: entry.approvedAt,
			};
		}
		return approvals;
	} catch (cause) {
		process.stderr.write(
			`${file} approves nothing: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		);
		return {};
	}
}

/** Record that `commit` of app `id` may run on this machine, or with `undefined`, forget `id`. */
export async function recordApproval(
	file: string,
	id: string,
	commit: string | undefined,
) {
	const approvals = await readApprovals(file);
	if (commit === undefined) delete approvals[id];
	else approvals[id] = { commit, approvedAt: Date.now() };
	const sorted = Object.fromEntries(
		Object.entries(approvals).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
	try {
		await writeReplacing(file, `${JSON.stringify(sorted, null, 2)}\n`);
	} catch (cause) {
		throw new Error(`The approval could not be recorded: ${String(cause)}`);
	}
}

/** Write `text` to `file` through a sibling, so a reader sees the old file or the new one. */
async function writeReplacing(file: string, text: string) {
	await mkdir(dirname(file), { recursive: true });
	const staged = join(dirname(file), `.${baseName(file)}.${randomSuffix()}`);
	try {
		await writeFile(staged, text);
		await rename(staged, file);
	} catch (cause) {
		await rm(staged, { force: true });
		throw cause;
	}
}

function baseName(path: string) {
	return path.slice(path.lastIndexOf(sep) + 1);
}

function randomSuffix() {
	return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// Git and other programs

const decoder = new TextDecoder();

/** Run `git` in `dir` through `@epicenter/folder`'s runner and return stdout, trimmed. */
async function git(dir: string, args: readonly string[]): Promise<string> {
	const { code, stdout } = await runGit(dir, args, false);
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

/** Whether `git` in `dir` succeeds. */
async function gitSucceeds(dir: string, args: readonly string[]) {
	return (await runGit(dir, args, true)).code === 0;
}

async function runGit(
	dir: string,
	args: readonly string[],
	allowFailure: boolean,
) {
	const signal = AbortSignal.timeout(GIT_TIMEOUT_MS);
	try {
		return await createGitRunner(dir)(args, { signal, allowFailure });
	} catch (cause) {
		if (signal.aborted)
			throw new Error(
				`git ${args[0]} did not finish within ${GIT_TIMEOUT_MS / 60_000} minutes and was stopped`,
			);
		throw cause;
	}
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
 * machine, so two never write the same clone, checkout, or build directory: an
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

/** A regular file's text, refusing links, other kinds, and large files. */
async function readRegularFile(path: string, limit: number) {
	const stats = await kindOf(path);
	if (stats === undefined) throw new Error('is missing');
	if (!stats.isFile()) throw new Error('is not a regular file');
	if (stats.size > limit) throw new Error(`is larger than ${limit} bytes`);
	return readFile(path, 'utf8');
}

/** The manifest in `dir`, an app's folder. */
async function readManifest(dir: string): Promise<Manifest> {
	let text: string;
	try {
		text = await readRegularFile(join(dir, MANIFEST), MAX_MANIFEST_BYTES);
	} catch (cause) {
		throw new Error(
			`${MANIFEST} ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	return parseManifest(text);
}

/** The folder the clone at `source` records as the app's, empty for the root. */
async function recordedFolder(source: string) {
	const recorded = await git(source, [
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
			`${FOLDER_KEY} in this app's .git/config is wrong: ${(cause as Error).message}`,
		);
	}
}

/** The directory of the app at `folder` in the repository at `root`, refused when a link takes it outside. */
async function appDir(root: string, folder: string) {
	if (folder === '') return root;
	const dir = join(root, folder);
	const realRoot = await realpath(root).catch((cause) => {
		throw new Error(`The app could not be read: ${String(cause)}`);
	});
	const realDir = await realpath(dir).catch(() => {
		throw new Error(`The repository has no folder ${folder}.`);
	});
	const inside = realDir === realRoot || realDir.startsWith(realRoot + sep);
	if (!inside || !(await stat(realDir)).isDirectory())
		throw new Error(`The folder ${folder} is not inside the repository.`);
	return dir;
}

/** The commit `builds/<id>/current` names, when its build is complete. */
export async function currentBuild(builds: string) {
	const named = await readFile(join(builds, CURRENT_BUILD), 'utf8').catch(
		() => undefined,
	);
	const commit = named?.trim();
	if (commit === undefined || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
		return undefined;
	return (await isCompleteBuild(builds, commit)) ? commit : undefined;
}

/**
 * Whether `builds/<commit>/` is a build this module finished:
 * `builds/<commit>.built` is written only after the build is renamed into
 * place, so a directory without it, partly copied or left by another
 * pipeline, is built again.
 */
async function isCompleteBuild(builds: string, commit: string) {
	const [directory, page, marker] = await Promise.all([
		kindOf(join(builds, commit)),
		kindOf(join(builds, commit, 'index.html')),
		kindOf(join(builds, `${commit}${BUILT_MARKER}`)),
	]);
	return (
		directory?.isDirectory() === true &&
		page?.isFile() === true &&
		marker?.isFile() === true
	);
}

async function review(
	source: string,
	approved: string | undefined,
	head: string,
): Promise<Review> {
	const from =
		approved !== undefined &&
		(await gitSucceeds(source, ['cat-file', '-e', `${approved}^{commit}`]))
			? approved
			: null;
	const text = (args: readonly string[]) =>
		git(source, args).catch((cause: Error) => cause.message);
	const logArgs = ['log', '--oneline', '--no-decorate', '-n', MAX_LOG_LINES];
	const [log, diffStat] =
		from === null
			? [await text([...logArgs, head]), '']
			: await Promise.all([
					text([...logArgs, `${from}..${head}`]),
					text(['diff', '--stat', from, head]),
				]);
	return { from, log, diffStat, statement: APPROVAL_STATEMENT };
}

/** The installed app under `Apps/<id>/`, as it is now. */
export async function inspect(
	paths: AppPaths,
	id: string,
): Promise<InstalledApp> {
	const source = join(paths.appsDir, id);
	let folder = '';
	const broken = (title: string, problem: string): InstalledApp => ({
		id,
		title,
		source: '',
		folder,
		commit: '',
		state: { kind: 'broken', problem },
	});
	let manifest: Manifest;
	try {
		folder = await recordedFolder(source);
		manifest = await readManifest(await appDir(source, folder));
	} catch (cause) {
		return broken(id, (cause as Error).message);
	}
	if (manifest.id !== id)
		return broken(
			manifest.title,
			`${MANIFEST} names the id '${manifest.id}', but the app is in Apps/${id}`,
		);
	let commit: string;
	try {
		commit = await git(source, ['rev-parse', '--verify', 'HEAD^{commit}']);
	} catch (cause) {
		return broken(manifest.title, (cause as Error).message);
	}
	// A commit runs only once approved, wherever it was made (ADR-0588).
	const approved = (await readApprovals(paths.approvalsFile))[id]?.commit;
	let state: AppState;
	if (approved !== commit)
		state = {
			kind: 'needsApproval',
			review: await review(source, approved, commit),
		};
	else if ((await currentBuild(join(paths.buildsDir, id))) === commit)
		state = { kind: 'ready' };
	else state = { kind: 'unbuilt' };
	const origin = await git(source, [
		'config',
		'--get',
		'remote.origin.url',
	]).catch(() => '');
	return { id, title: manifest.title, source: origin, folder, commit, state };
}

/** Every installed app, by id. */
export async function listInstalled(paths: AppPaths): Promise<InstalledApp[]> {
	const entries = await readdir(paths.appsDir, { withFileTypes: true }).catch(
		(cause: { code?: string }) => {
			if (cause.code === 'ENOENT') return [];
			throw new Error(`The Apps folder could not be read: ${String(cause)}`);
		},
	);
	const ids = entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
		.map((entry) => entry.name)
		.sort();
	return Promise.all(ids.map((id) => inspect(paths, id)));
}

// ---------------------------------------------------------------------------
// Listing a repository, installing, updating, building, removing

/**
 * Clone `source` into a dot directory of `Apps/`, which no listing reads, and
 * run `work` on the clone. The clone is removed unless `work` moved it.
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
		throw new Error(`The Apps folder could not be made: ${String(cause)}`);
	});
	const staging = join(paths.appsDir, `.installing-${randomSuffix()}`);
	try {
		await git(paths.appsDir, [
			'clone',
			'--no-recurse-submodules',
			'--template=',
			...cloneArgs,
			'--',
			source,
			staging,
		]);
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
			['--no-checkout', '--depth=1', '--filter=blob:none'],
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
						const text = await git(clone, ['cat-file', 'blob', `HEAD:${path}`]);
						if (text.length > MAX_MANIFEST_BYTES)
							throw new Error(`is larger than ${MAX_MANIFEST_BYTES} bytes`);
						const manifest = parseManifest(text);
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
	/** Approve the commit that would run, then build it. */
	approve?: boolean;
	/** The commit a person was shown: refuse unless it is the one checked out. */
	commit?: string;
	onProgress?: Progress;
};

/**
 * Clone `source` into `Apps/<id>/`, the id read from the manifest in `folder`
 * (empty for the root), record `folder` in the clone's `.git/config`, then
 * build its commit if it is approved. A commit no one approved on this
 * machine waits for approval unless `approve` is set.
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
		const id = await withStagedClone(paths, from, [], async (staging) => {
			let manifest: Manifest;
			try {
				manifest = await readManifest(await appDir(staging, normalized));
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
					`An app with the id ${manifest.id} is already installed in Apps/${manifest.id}.`,
				);
			await rename(staging, destination).catch((cause) => {
				throw new Error(
					`The app could not be moved into place: ${String(cause)}`,
				);
			});
			return manifest.id;
		});
		return settle(paths, id, options);
	});
}

/**
 * Bring app `id` up to date and build its commit if it is approved. Without
 * `commit`, fetch its upstream and bring its commits onto it: a
 * fast-forward, or a rebase of the commits made here, undone and reported if
 * it conflicts. With `commit`, fetch nothing and act only on that commit, the
 * one a person was shown. A commit not yet approved waits for approval
 * unless `approve` is set.
 */
export async function update(
	paths: AppPaths,
	id: string,
	options: SettleOptions = {},
): Promise<InstalledApp> {
	return exclusively(paths, async () => {
		const source = await installedSource(paths, id);
		if (options.commit === undefined) {
			await requireClean(source);
			options.onProgress?.('Fetching updates…');
			await git(source, ['fetch', '--no-recurse-submodules', 'origin']);
			if (
				!(await gitSucceeds(source, [
					'rev-parse',
					'--verify',
					'-q',
					'@{upstream}^{commit}',
				]))
			)
				throw new Error(
					"This app's branch follows no upstream branch, so there is nothing to update from.",
				);
			const behindOnly = await gitSucceeds(source, [
				'merge-base',
				'--is-ancestor',
				'HEAD',
				'@{upstream}',
			]);
			if (behindOnly) await git(source, ['merge', '--ff-only', '@{upstream}']);
			else {
				try {
					await git(source, ['rebase', '@{upstream}']);
				} catch (cause) {
					await gitSucceeds(source, ['rebase', '--abort']);
					throw new Error(
						`The commits made here conflict with the update, so nothing changed. Resolve it in Apps/${id} with Git. (${(cause as Error).message})`,
					);
				}
			}
		}
		return settle(paths, id, options);
	});
}

/**
 * Build app `id` when its commit is approved, or when `approve` approves it;
 * otherwise leave it waiting for approval.
 */
async function settle(
	paths: AppPaths,
	id: string,
	{ approve = false, commit, onProgress }: SettleOptions,
): Promise<InstalledApp> {
	const app = await inspect(paths, id);
	if (app.state.kind === 'broken') throw new Error(app.state.problem);
	if (commit !== undefined && app.commit !== commit)
		throw new Error(
			`${app.title} changed since it was shown. Review it again.`,
		);
	if (app.state.kind === 'ready') return app;
	if (app.state.kind === 'needsApproval') {
		if (!approve) return app;
		await recordApproval(paths.approvalsFile, id, app.commit);
	}
	await build(paths, app, onProgress);
	return inspect(paths, id);
}

async function installedSource(paths: AppPaths, id: string) {
	const problem = appIdProblem(id);
	if (problem !== undefined) throw new Error(`'${id}' ${problem}.`);
	const source = join(paths.appsDir, id);
	if (!(await kindOf(source))?.isDirectory())
		throw new Error(`No app is installed in Apps/${id}.`);
	return source;
}

/** Refuse to fetch and rebase over changes that are not committed. */
async function requireClean(source: string) {
	const changes = await git(source, [
		'status',
		'--porcelain',
		'--untracked-files=no',
	]);
	if (changes !== '')
		throw new Error(
			'This app has changes that are not committed. Commit or discard them first, so updating cannot lose them.',
		);
}

/**
 * Make `app`'s commit the current build: `builds/<id>/<commit>/` when it is
 * a complete build (`isCompleteBuild`), which is kept as it is, since a
 * window may be running it; otherwise a new build of that commit alone. The
 * commit is checked out detached under `checkouts/<id>/` (`checkOut`), then
 * `bun install` runs at the checkout's root and `bun run build:installed` in
 * the app's folder, whose `dist/` is copied to a sibling of
 * `builds/<id>/<commit>/`, renamed into place, and marked complete with
 * `builds/<id>/<commit>.built`. The checkout is removed after. What both
 * print goes to `builds/<id>/<commit>.log`.
 */
async function build(
	paths: AppPaths,
	app: InstalledApp,
	onProgress?: Progress,
) {
	const builds = join(paths.buildsDir, app.id);
	const makeCurrent = () =>
		writeReplacing(join(builds, CURRENT_BUILD), `${app.commit}\n`).catch(
			(cause) => {
				throw new Error(
					`${app.title} could not be made current: ${String(cause)}`,
				);
			},
		);
	if (await isCompleteBuild(builds, app.commit)) {
		await makeCurrent();
		return;
	}

	await mkdir(builds, { recursive: true }).catch((cause) => {
		throw new Error(`The build folder could not be made: ${String(cause)}`);
	});
	const logPath = join(builds, `${app.commit}.log`);
	const failed = (problem: string) =>
		new Error(`${app.title} did not build: ${problem}. See ${logPath}`);
	const unreadable = (problem: string) =>
		new Error(`${app.title} did not build: ${problem}.`);
	const source = join(paths.appsDir, app.id);
	const checkout = join(paths.cacheDir, CHECKOUTS, app.id);
	// One build runs at a time (`exclusively`), so a checkout, or a dot entry
	// in the build folder (a staged copy, a build moved aside, a staged
	// `current`), was left by a build that did not finish.
	try {
		await removeCheckout(source, checkout);
		for (const name of await readdir(builds))
			if (name.startsWith('.'))
				await rm(join(builds, name), { recursive: true, force: true });
	} catch (cause) {
		throw new Error(
			`${checkout} or a staged copy in ${builds} is left from an earlier build and could not be removed: ${String(cause)}. Delete it and try again.`,
		);
	}
	try {
		onProgress?.('Checking out the commit…');
		await checkOut(source, checkout, app.commit).catch((cause: Error) => {
			throw unreadable(
				`commit ${app.commit} could not be checked out (${cause.message})`,
			);
		});
		const dir = await appDir(checkout, app.folder);
		const { id, title } = await readManifest(dir).catch((cause: Error) => {
			throw unreadable(cause.message);
		});
		if (id !== app.id)
			throw unreadable(`at this commit ${MANIFEST} names the id '${id}'`);
		const env = await buildEnvironment(paths.cacheDir);
		const log = openSync(logPath, 'w');
		try {
			if ((await kindOf(join(checkout, 'package.json')))?.isFile()) {
				onProgress?.('Installing dependencies…');
				await runBun(
					['install', '--frozen-lockfile', '--ignore-scripts'],
					checkout,
					env,
					log,
				);
			}
			onProgress?.(`Building ${title}…`);
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
		onProgress?.('Keeping the build…');
		await keep(output, builds, app.commit).catch((cause) => {
			throw failed(`the build could not be kept: ${String(cause)}`);
		});
	} finally {
		// Best effort: the build's own outcome is the result.
		await removeCheckout(source, checkout).catch((cause) => {
			process.stderr.write(
				`the checkout ${checkout} could not be removed: ${String(cause)}\n`,
			);
		});
	}
	await makeCurrent();
}

/**
 * Copy `output` beside `builds/<commit>/`, rename it into place, and write
 * `builds/<commit>.built`. A directory already at `<commit>/` is an
 * incomplete build, which is moved aside for the moment between the two
 * renames and then deleted.
 */
async function keep(output: string, builds: string, commit: string) {
	const destination = join(builds, commit);
	const staged = join(builds, `.${commit}-${randomSuffix()}`);
	const aside = join(builds, `.${commit}-${randomSuffix()}-old`);
	let movedAside = false;
	try {
		await copyTree(output, staged);
		movedAside = await rename(destination, aside).then(
			() => true,
			(cause: NodeJS.ErrnoException) => {
				if (cause.code === 'ENOENT') return false;
				throw cause;
			},
		);
		await rename(staged, destination);
	} catch (cause) {
		if (movedAside) await rename(aside, destination).catch(() => {});
		await rm(staged, { recursive: true, force: true });
		throw cause;
	}
	if (movedAside) await rm(aside, { recursive: true, force: true });
	await writeFile(join(builds, `${commit}${BUILT_MARKER}`), '');
}

/**
 * Configuration for the checkout's Git: every filter driver this clone's
 * configuration names, from any level, emptied and not required, so no
 * smudge, clean, or process command runs however `.gitattributes` or
 * `.git/info/attributes` map files to it. Replace refs are ignored with
 * `--no-replace-objects`, so the checkout holds the commit's own tree.
 */
async function checkoutOptions(source: string) {
	const names = await git(source, [
		'config',
		'--name-only',
		'-z',
		'--get-regexp',
		'^filter\\..+\\.(smudge|clean|process|required)$',
	]).catch(() => '');
	const drivers = new Set(
		names
			.split('\0')
			.filter((name) => name !== '')
			.map((name) => name.slice('filter.'.length, name.lastIndexOf('.'))),
	);
	const options = ['--no-replace-objects'];
	for (const driver of drivers)
		for (const [key, value] of [
			['smudge', ''],
			['clean', ''],
			['process', ''],
			['required', 'false'],
		])
			options.unshift('-c', `filter.${driver}.${key}=${value}`);
	return options;
}

/** Check `commit` out detached at `checkout`, a worktree of the clone at `source`. */
async function checkOut(source: string, checkout: string, commit: string) {
	await mkdir(dirname(checkout), { recursive: true });
	// `--force` takes over a path a build that did not finish left
	// registered, without pruning anyone else's worktree.
	await git(source, [
		...(await checkoutOptions(source)),
		'worktree',
		'add',
		'--force',
		'--detach',
		'--',
		checkout,
		commit,
	]);
}

/** Remove the checkout at `checkout` and its registration in the clone at `source`. */
async function removeCheckout(source: string, checkout: string) {
	if ((await kindOf(checkout)) === undefined) return;
	await gitSucceeds(source, [
		...(await checkoutOptions(source)),
		'worktree',
		'remove',
		'--force',
		'--force',
		'--',
		checkout,
	]);
	await rm(checkout, { recursive: true, force: true });
}

/** Copy the regular files and directories under `from` to `to`; links are left behind. */
async function copyTree(from: string, to: string) {
	await mkdir(to, { recursive: true });
	for (const entry of await readdir(from, { withFileTypes: true })) {
		const target = join(to, entry.name);
		if (entry.isDirectory()) await copyTree(join(from, entry.name), target);
		else if (entry.isFile()) await copyFile(join(from, entry.name), target);
	}
}

/**
 * Remove app `id`: its clone and its approval. Its builds stay, since a
 * window may still be running one (removing them is later work). Refused while
 * the clone holds work no remote has, uncommitted changes or commits made
 * here, since removing would lose it.
 */
export async function remove(paths: AppPaths, id: string): Promise<void> {
	return exclusively(paths, async () => {
		const source = await installedSource(paths, id);
		const keep = (why: string) =>
			new Error(
				`Apps/${id} ${why}, which removing would lose. Push or discard it, or delete ${source} yourself.`,
			);
		let changes: string;
		let unpushed: string;
		try {
			changes = await git(source, ['status', '--porcelain']);
			unpushed = await git(source, [
				'rev-list',
				'--count',
				'HEAD',
				'--not',
				'--remotes',
			]);
		} catch (cause) {
			throw keep(
				`could not be read as a repository (${(cause as Error).message})`,
			);
		}
		if (changes !== '') throw keep('has changes that are not committed');
		if (unpushed !== '0')
			throw keep(
				`has ${unpushed} commit${unpushed === '1' ? '' : 's'} made here that no remote has`,
			);
		await rm(source, { recursive: true, force: true });
		await rm(join(paths.cacheDir, CHECKOUTS, id), {
			recursive: true,
			force: true,
		});
		if ((await readApprovals(paths.approvalsFile))[id] !== undefined)
			await recordApproval(paths.approvalsFile, id, undefined);
	});
}
