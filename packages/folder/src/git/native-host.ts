/**
 * The native Git backend's host in Bun and Node: the system `git` and
 * `node:fs`. Every desktop Git operation runs here, in the `epicenter` CLI
 * (ADR-0559), so these are the one set of Git safety rules: the shell runs
 * no `git`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { nodeDirectoryPrimitives } from '../directory-node.js';
import type { GitInstall } from './errors.js';
import {
	credentialEnvironment,
	GitCommandError,
	type GitRun,
	type NativeGitHost,
} from './native-backend.js';

/**
 * Inherited variables that would point Git at another repository, index, or
 * object store: the names `git rev-parse --local-env-vars` lists, plus the
 * ref namespace. Each command addresses the repository in its working
 * directory, whatever the parent process had set. The ceiling stops discovery
 * at the root, so a root whose `.git` is missing never resolves to a
 * repository in a directory above it. `GIT_OPTIONAL_LOCKS=0` keeps read-only
 * commands such as `status` and `diff` from taking `index.lock` to refresh
 * the index, so observing the folder never looks like a change to it.
 * `GIT_SSH_COMMAND` goes too, so SSH runs as Git's configuration says.
 *
 * Trace variables are removed too, and Trace2 is switched off, because a
 * trace records Git's configuration and requests, credential headers
 * included, to stderr or to any file it names.
 */
const REPOSITORY_ENV =
	/^GIT_(DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|GRAFT_FILE|SHALLOW_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|TRACE.*|CURL_VERBOSE|SSH_COMMAND)$/;

function gitEnvironment(root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env))
		if (!REPOSITORY_ENV.test(name)) env[name] = value;
	return {
		...env,
		GIT_CEILING_DIRECTORIES: dirname(root),
		GIT_OPTIONAL_LOCKS: '0',
		GIT_TERMINAL_PROMPT: '0',
		GIT_TRACE2: '0',
		GIT_TRACE2_EVENT: '0',
		GIT_TRACE2_PERF: '0',
		LC_ALL: 'C',
	};
}

/**
 * The directory `core.hooksPath` names for every command: no hook is found
 * there on any platform, whatever the repository or the person configures.
 * It is made when missing, and before each command it must be a real, empty
 * directory, since a hook another program planted there would run on
 * `git add`. Before the repository exists it is only named: `git init` runs
 * no hook, and the next command makes it.
 */
async function noHooksDirectory(root: string): Promise<string> {
	const git = join(root, '.git');
	const epicenter = join(git, 'epicenter');
	const noHooks = join(epicenter, 'no-hooks');
	const kind = (path: string) =>
		lstat(path).catch((cause: { code?: string }) => {
			if (cause.code === 'ENOENT') return undefined;
			throw cause;
		});
	if (!(await kind(git))?.isDirectory()) return noHooks;
	// `mkdir` would follow a linked `.git/epicenter` out of the folder.
	const parent = await kind(epicenter);
	if (parent !== undefined && !parent.isDirectory())
		throw new Error(
			`'${epicenter}' must be a directory, because every Git command looks for hooks inside it; remove it, and it is made again`,
		);
	await mkdir(noHooks, { recursive: true });
	const found = await kind(noHooks);
	if (!found?.isDirectory() || (await readdir(noHooks)).length > 0)
		throw new Error(
			`'${noHooks}' must be an empty directory, because every Git command looks for hooks there; remove it, and it is made again empty`,
		);
	return noHooks;
}

/** No usable `git` was found on this computer (ADR-0559). */
export class GitMissingError extends Error {
	readonly install = gitInstall();
	constructor() {
		super(
			process.platform === 'darwin'
				? 'git is not installed; install the Command Line Tools for Xcode to keep versions and sync'
				: process.platform === 'win32'
					? 'git is not installed; install Git for Windows to keep versions and sync'
					: 'git is not installed; install it with your package manager to keep versions and sync',
		);
		this.name = 'GitMissingError';
	}
}

/** How this computer gets a `git`. */
export function gitInstall(): GitInstall {
	if (process.platform === 'darwin') return 'command-line-tools';
	if (process.platform === 'win32') return 'git-for-windows';
	return 'package-manager';
}

/** Whether `program` runs as `git` (`git --version` exits 0). */
function runs(program: string): boolean {
	const result = spawnSync(program, ['--version'], {
		stdio: 'ignore',
		env: { ...process.env, LC_ALL: 'C' },
		timeout: 10_000,
	});
	return result.status === 0;
}

/**
 * The developer directory `xcode-select -p` names, when it exists: then
 * `/usr/bin/git` is real Git and not the xcrun shim, which exits 1 and shows
 * the Command Line Tools install dialog. `xcode-select -p` itself shows no
 * dialog.
 */
function developerDirectory(): string | undefined {
	const result = spawnSync('/usr/bin/xcode-select', ['-p'], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
		timeout: 10_000,
	});
	const directory = result.stdout?.trim() ?? '';
	return result.status === 0 && directory !== '' && existsSync(directory)
		? directory
		: undefined;
}

/** Each `git` on `PATH`, in order, by absolute path. */
function onPath(): string[] {
	const names = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git'];
	const found: string[] = [];
	for (const directory of (process.env.PATH ?? '').split(delimiter)) {
		if (directory === '') continue;
		for (const name of names) {
			const candidate = join(directory, name);
			try {
				if (statSync(candidate).isFile() && !found.includes(candidate))
					found.push(candidate);
			} catch {}
		}
	}
	return found;
}

/**
 * The `git` this process runs, found without starting the xcrun shim
 * (ADR-0559). `EPICENTER_GIT` names one outright. Otherwise, on macOS,
 * `/opt/homebrew/bin/git` and `/usr/local/bin/git` come first, since an app
 * Finder starts gets launchd's `PATH`, then any other `git` on `PATH`, and
 * `/usr/bin/git` last and only when `xcode-select -p` names an installed
 * developer directory, whose own `usr/bin/git` runs instead of the shim when
 * it is there: the shim looks that directory up again on every run, which
 * doubles each `git`'s start (8 ms against 4, measured on macOS arm64).
 * Elsewhere, the first `git` on `PATH`. Each candidate must run
 * `git --version`. Throws `GitMissingError` when none does.
 */
export function locateGit(): string {
	located ??= find();
	if (located === MISSING) throw new GitMissingError();
	return located;
}
const MISSING = '';
let located: string | undefined;

function find(): string {
	const named = process.env.EPICENTER_GIT;
	if (named !== undefined && named !== '') return runs(named) ? named : MISSING;
	if (process.platform !== 'darwin') {
		for (const candidate of onPath()) if (runs(candidate)) return candidate;
		return MISSING;
	}
	const shim = '/usr/bin/git';
	const candidates = [
		'/opt/homebrew/bin/git',
		'/usr/local/bin/git',
		...onPath().filter((candidate) => candidate !== shim),
	];
	for (const candidate of new Set(candidates))
		if (existsSync(candidate) && runs(candidate)) return candidate;
	const developer = developerDirectory();
	if (developer === undefined) return MISSING;
	const direct = join(developer, 'usr', 'bin', 'git');
	if (existsSync(direct) && runs(direct)) return direct;
	return runs(shim) ? shim : MISSING;
}

/**
 * A remote the folder may sync with: `https://` or `ssh://` with a host,
 * `http://` only to this computer's loopback (`127.0.0.1` or `localhost`,
 * for a development server), or SSH's `user@host:path`. Never a local path,
 * `file://`, or a `transport::address` helper such as `ext::`, which would
 * run a program or write another repository on this computer; and never a
 * URL that carries a password, which Git would keep in the folder's
 * configuration and put in its arguments.
 */
export function isNetworkUrl(url: string): boolean {
	if (
		url === '' ||
		url.startsWith('-') ||
		url.includes('::') ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
		/[\u0000-\u0020\u007f]/.test(url)
	)
		return false;
	const authorityOf = (rest: string) => rest.split(/[/?#]/)[0] ?? '';
	if (url.startsWith('http://')) {
		const authority = authorityOf(url.slice('http://'.length));
		const colon = authority.indexOf(':');
		const host = colon === -1 ? authority : authority.slice(0, colon);
		const port = colon === -1 ? '' : authority.slice(colon + 1);
		return (
			(colon === -1 || /^[0-9]+$/.test(port)) &&
			(host === '127.0.0.1' || host === 'localhost')
		);
	}
	for (const scheme of ['https://', 'ssh://'])
		if (url.startsWith(scheme)) {
			const authority = authorityOf(url.slice(scheme.length));
			const at = authority.lastIndexOf('@');
			const user = at === -1 ? '' : authority.slice(0, at);
			const host = at === -1 ? authority : authority.slice(at + 1);
			return host !== '' && !host.startsWith('-') && !user.includes(':');
		}
	const at = url.indexOf('@');
	if (at === -1) return false;
	const user = url.slice(0, at);
	const rest = url.slice(at + 1);
	const colon = rest.indexOf(':');
	if (colon === -1) return false;
	const host = rest.slice(0, colon);
	const path = rest.slice(colon + 1);
	const name = (part: string) =>
		/^[A-Za-z0-9._-]+$/.test(part) && !part.startsWith('-');
	return name(user) && name(host) && path !== '' && !path.startsWith('-');
}

/**
 * Why `root`'s Git state would send writes somewhere else, or `undefined`:
 * `.git` as a link or a `gitdir:` file, a `.git/commondir`, or a link at
 * `.git/objects`, among its first level, or anywhere in `.git/refs` and
 * `.git/logs`, through which `hash-object -w` and `update-ref` would write
 * outside the folder; or a linked `.git/epicenter`. The shell checks the
 * same when it grants a folder (`verify_layout` in the folder plugin); the
 * CLI checks again before each history operation, since another program may
 * change `.git` while the folder is open.
 */
export async function gitLayoutProblem(
	root: string,
): Promise<string | undefined> {
	const kind = (path: string) =>
		lstat(path).catch((cause: { code?: string }) => {
			if (cause.code === 'ENOENT') return undefined;
			throw cause;
		});
	const git = join(root, '.git');
	const top = await kind(git);
	if (top === undefined) return undefined;
	if (top.isSymbolicLink()) return '.git is a symbolic link';
	if (!top.isDirectory())
		return '.git is a file that points at another Git directory';
	if ((await kind(join(git, 'commondir'))) !== undefined)
		return ".git/commondir exists, so the repository's objects and refs live in another Git directory";
	const links = async (
		path: string,
		label: string,
		depth: number,
	): Promise<string | undefined> => {
		const found = await kind(path);
		if (found === undefined) return undefined;
		if (found.isSymbolicLink()) return `${label} is a symbolic link`;
		if (!found.isDirectory() || depth === 0) return undefined;
		for (const name of await readdir(path)) {
			const problem = await links(
				join(path, name),
				`${label}/${name}`,
				depth - 1,
			);
			if (problem !== undefined) return problem;
		}
		return undefined;
	};
	for (const [name, depth] of [
		['objects', 1],
		['refs', Number.POSITIVE_INFINITY],
		['logs', Number.POSITIVE_INFINITY],
	] as const) {
		const problem = await links(join(git, name), `.git/${name}`, depth);
		if (problem !== undefined) return problem;
	}
	const epicenter = await kind(join(git, 'epicenter'));
	if (epicenter !== undefined && !epicenter.isDirectory())
		return '.git/epicenter is not a directory';
	return undefined;
}

/** The process groups of the `git` commands running now, by leader. */
const running = new Set<number>();

/**
 * End every `git` this process started that is still running, with the
 * helpers each started, such as `git-remote-https`. The CLI calls this when
 * the shell ends it (ADR-0559).
 */
export function endGitCommands() {
	for (const group of running) killGroup(group);
	running.clear();
}

function killGroup(group: number) {
	try {
		if (process.platform === 'win32') process.kill(group, 'SIGKILL');
		else process.kill(-group, 'SIGKILL');
	} catch {
		// Already gone.
	}
}

/**
 * Run the system `git` (`locateGit`) in `root`: no hook and no fsmonitor,
 * whatever the repository configures, the environment above, and a
 * credential sent only to an `https` URL, never in the clear. Each `git`
 * leads its own process group, so an abort ends it with every helper it
 * started. Throws `GitMissingError` when this computer has no `git`.
 */
export function createGitRunner(root: string): GitRun {
	return async (args, options = {}) => {
		if (
			options.credential !== undefined &&
			!options.credential.url.startsWith('https://')
		)
			throw new Error(
				`a token is sent only to an https remote, and ${options.credential.url} is not one; connect it with its https URL, or leave the token out so Git uses your own sign-in`,
			);
		options.signal?.throwIfAborted();
		const program = locateGit();
		const noHooks = await noHooksDirectory(root);
		return new Promise((resolve, reject) => {
			const child = spawn(
				program,
				[
					'-c',
					`core.hooksPath=${noHooks}`,
					'-c',
					'core.fsmonitor=false',
					...args,
				],
				{
					cwd: root,
					env: {
						...gitEnvironment(root),
						...options.env,
						...(options.credential &&
							credentialEnvironment(options.credential)),
					},
					stdio: ['pipe', 'pipe', 'pipe'],
					// Its own process group, which an abort ends whole.
					detached: process.platform !== 'win32',
				},
			);
			const group = child.pid;
			if (group !== undefined) running.add(group);
			const abort = () => {
				if (group !== undefined) killGroup(group);
			};
			options.signal?.addEventListener('abort', abort, { once: true });
			const stdout: Uint8Array[] = [];
			const stderr: Uint8Array[] = [];
			child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
			child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));
			const settle = () => {
				if (group !== undefined) running.delete(group);
				options.signal?.removeEventListener('abort', abort);
			};
			child.on('error', (cause) => {
				settle();
				reject(cause);
			});
			child.on('close', (code) => {
				settle();
				if (options.signal?.aborted) {
					reject(options.signal.reason);
					return;
				}
				const out = Buffer.concat(stdout);
				const err = Buffer.concat(stderr).toString('utf8');
				if (code !== 0 && !options.allowFailure)
					reject(new GitCommandError(args, code, err));
				else resolve({ code, stdout: new Uint8Array(out), stderr: err });
			});
			child.stdin.on('error', () => {});
			if (options.input !== undefined) child.stdin.end(options.input);
			else child.stdin.end();
		});
	};
}

/** The system `git` in `root`, and `node:fs`. */
export function nodeGitHost(root: string): NativeGitHost {
	return { run: createGitRunner(root), files: nodeDirectoryPrimitives };
}
