/**
 * The system `git` in Bun and Node, for the `epicenter` CLI (ADR-0559): found
 * without the xcrun shim, run with one set of safety rules (no hooks, no
 * fsmonitor, no `ext` or `fd` transport, no inherited repository
 * variables), and given a credential only as an `Authorization` header for
 * its own `https` remote. `epicenter init`, `sync`, and `clone` run every
 * `git` through `runGit`; the shell runs none.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export class GitCommandError extends Error {
	constructor(
		readonly args: readonly string[],
		readonly code: number | null,
		readonly stderr: string,
	) {
		super(
			stderr.trim() === ''
				? `git ${args[0]} exited with ${code}`
				: `git ${args[0]}: ${stderr.trim()}`,
		);
		this.name = 'GitCommandError';
	}
}

export type GitRun = (
	args: readonly string[],
	options?: {
		input?: Uint8Array | string;
		signal?: AbortSignal;
		allowFailure?: boolean;
		env?: Readonly<Record<string, string>>;
		/**
		 * An `Authorization` header for a push or fetch, sent only to `url`,
		 * which is the remote the command names. The host passes it to Git
		 * outside its arguments.
		 */
		credential?: GitAuthorization;
	},
) => Promise<{ code: number | null; stdout: Uint8Array; stderr: string }>;

/** One `Authorization` header value, for exactly one URL. */
type GitAuthorization = {
	readonly url: string;
	readonly authorization: string;
};

/**
 * The Git configuration that sends `credential`'s header to its URL alone,
 * follows no redirect, and asks no credential helper, as environment
 * variables, so the header never appears in a process list. Redirects are
 * refused for the URL too: Git prefers a URL-specific
 * `http.<url>.followRedirects` from any other configuration over a plain
 * `http.followRedirects`.
 */
export function credentialEnvironment({
	url,
	authorization,
}: GitAuthorization): Record<string, string> {
	if (!/^(Basic|Bearer) [\x21-\x7e]+$/.test(authorization))
		throw new Error('A Git credential must be one Basic or Bearer header');
	return {
		GIT_CONFIG_COUNT: '4',
		GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
		GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
		GIT_CONFIG_KEY_1: 'http.followRedirects',
		GIT_CONFIG_VALUE_1: 'false',
		GIT_CONFIG_KEY_2: `http.${url}.followRedirects`,
		GIT_CONFIG_VALUE_2: 'false',
		GIT_CONFIG_KEY_3: 'credential.helper',
		GIT_CONFIG_VALUE_3: '',
	};
}

/** A username and password for one remote. A token is the password. */
export type GitCredential = {
	readonly username: string;
	readonly password: string;
};

/**
 * Asked right before each push and fetch, with the exact URL Git is about to
 * reach. `undefined` sends no credential; a throw refuses the transfer. The
 * folder keeps nothing it returns: not in `origin`, its files, or its Git
 * configuration.
 */
export type GitCredentials = (
	url: string,
	signal: AbortSignal,
) => Promise<GitCredential | undefined>;

/** The `Authorization` value for `credential`: HTTP Basic, UTF-8. */
export function basicAuthorization({ username, password }: GitCredential) {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

/** How a computer without `git` gets one. */
export type GitInstall =
	| 'command-line-tools'
	| 'git-for-windows'
	| 'package-manager';

/**
 * Inherited variables that would point Git at another repository, index, or
 * object store: the names `git rev-parse --local-env-vars` lists, plus the
 * ref namespace. Each command addresses the repository it finds from its
 * working directory, whatever the parent process had set; the person's
 * `GIT_CEILING_DIRECTORIES` still bounds that search. `GIT_SSH_COMMAND` goes
 * too, so SSH runs as Git's configuration says.
 *
 * Trace variables are removed too, and Trace2 is switched off, because a
 * trace records Git's configuration and requests, credential headers
 * included, to stderr or to any file it names.
 */
const REPOSITORY_ENV =
	/^GIT_(DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|GRAFT_FILE|SHALLOW_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|TRACE.*|CURL_VERBOSE|SSH_COMMAND)$/;

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
function gitInstall(): GitInstall {
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
 * Configuration every `git` this process starts runs with, ahead of its own
 * arguments: no hook and no fsmonitor, whatever the repository or the person
 * configures; the `ext` and `fd` transports refused, since each runs an
 * arbitrary command; and no color in output this process reads. A `-c`
 * reaches every `git` the command starts in turn, such as a submodule's.
 *
 * `core.autocrlf=false` and `core.eol=lf` cover line endings that come from
 * configuration alone: a person's `core.autocrlf` (Git for Windows sets
 * `true` when it installs), and the `native` default of `core.eol`, which is
 * CRLF on Windows for a file `text` selects. Attributes still apply: a
 * committed `.gitattributes` selects the LFS filter and the note merge
 * driver (`epicenter init`), and filters are configuration, not hooks.
 */
const SAFETY = (hooksPath: string) => [
	'-c',
	`core.hooksPath=${hooksPath}`,
	'-c',
	'core.fsmonitor=false',
	'-c',
	'core.autocrlf=false',
	'-c',
	'core.eol=lf',
	'-c',
	'protocol.ext.allow=never',
	'-c',
	'protocol.fd.allow=never',
	'-c',
	'color.ui=never',
];

type GitRunOptions = NonNullable<Parameters<GitRun>[1]>;

/**
 * Run the system `git` (`locateGit`) in `cwd` (this process's by default):
 * the safety configuration above, with hooks looked for nowhere, and
 * `environment` (this process's by default) without the variables that
 * would point it at another repository. A credential goes only to an
 * `https` URL, never in the clear. Each `git` leads its own process group,
 * so an abort ends it with every helper it started. Throws
 * `GitMissingError` when this computer has no `git`.
 */
export async function runGit(
	args: readonly string[],
	{
		cwd,
		environment = process.env,
		...options
	}: GitRunOptions & {
		readonly cwd?: string;
		readonly environment?: Readonly<Record<string, string | undefined>>;
	} = {},
): ReturnType<GitRun> {
	refuseCleartextCredential(options);
	options.signal?.throwIfAborted();
	const program = locateGit();
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(environment))
		if (!REPOSITORY_ENV.test(name)) env[name] = value;
	return spawnGit(program, [...SAFETY(devNull), ...args], {
		cwd,
		env: {
			...env,
			GIT_TERMINAL_PROMPT: '0',
			GIT_TRACE2: '0',
			GIT_TRACE2_EVENT: '0',
			GIT_TRACE2_PERF: '0',
			LC_ALL: 'C',
		},
		options,
	});
}

const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';

function refuseCleartextCredential(options: GitRunOptions) {
	if (
		options.credential !== undefined &&
		!options.credential.url.startsWith('https://')
	)
		throw new Error(
			`a token is sent only to an https remote, and ${options.credential.url} is not one; connect it with its https URL, or leave the token out so Git uses your own sign-in`,
		);
}

function spawnGit(
	program: string,
	args: readonly string[],
	{
		cwd,
		env,
		options,
	}: {
		cwd: string | undefined;
		env: NodeJS.ProcessEnv;
		options: GitRunOptions;
	},
): ReturnType<GitRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, {
			cwd,
			env: {
				...env,
				...options.env,
				...(options.credential && credentialEnvironment(options.credential)),
			},
			stdio: ['pipe', 'pipe', 'pipe'],
			// Its own process group, which an abort ends whole.
			detached: process.platform !== 'win32',
		});
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
			// The arguments this process chose, not the safety configuration.
			const named = args.slice(SAFETY('').length);
			if (code !== 0 && !options.allowFailure)
				reject(new GitCommandError(named, code, err));
			else resolve({ code, stdout: new Uint8Array(out), stderr: err });
		});
		child.stdin.on('error', () => {});
		if (options.input !== undefined) child.stdin.end(options.input);
		else child.stdin.end();
	});
}
