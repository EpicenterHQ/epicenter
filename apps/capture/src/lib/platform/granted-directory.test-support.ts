/**
 * Test helper: the desktop shell's half of a folder it granted to a page,
 * over a real directory.
 *
 * `shellCommand` answers what the shell answers after `grant_directory`: the
 * folder plugin's change commands with `node:fs`, and `run_git` with the
 * system `git` in the granted root. `fsPlugin` is Tauri's fs plugin over
 * `node:fs`, failing as the plugin does, with the operating system's message
 * as text. `installWebLocks` stands in for Web Locks, which Bun lacks.
 *
 * Neither checks paths the way the shell does; the folder package's own
 * tests and the shell's cover that. Git reads no global or system
 * configuration here, so the grant's author is the one Git records.
 */
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A fresh directory under the system temp directory, by its real path. */
export async function scratch(prefix: string): Promise<string> {
	return nodeFs.realpath(await nodeFs.mkdtemp(join(tmpdir(), prefix)));
}

/** Variables that would point Git at another repository, or trace it. */
const REPOSITORY_ENV =
	/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CONFIG\w*|TRACE\w*)$/;

function gitEnvironment(root: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env))
		if (value !== undefined && !REPOSITORY_ENV.test(name)) env[name] = value;
	return {
		...env,
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CEILING_DIRECTORIES: dirname(root),
		GIT_OPTIONAL_LOCKS: '0',
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C',
	};
}

async function runGit(
	root: string,
	args: readonly string[],
	options: { input?: Uint8Array; indexFile?: string } = {},
) {
	const child = Bun.spawn(['git', ...args], {
		cwd: root,
		env: {
			...gitEnvironment(root),
			...(options.indexFile === undefined
				? {}
				: { GIT_INDEX_FILE: options.indexFile }),
		},
		stdin: options.input ?? 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).bytes(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

/** Run `git` in `root` as a person would, failing on a nonzero exit. */
export async function git(root: string, ...args: string[]): Promise<string> {
	const { code, stdout, stderr } = await runGit(root, args);
	if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
	return new TextDecoder().decode(stdout).trim();
}

/**
 * The arguments of one `invoke`, as the shell reads them. A command that takes
 * a raw body (`write_folder_file`) carries the rest in percent-encoded
 * headers, decoded here beside the body as `bytes`.
 */
export function shellArguments(
	body: Record<string, unknown> | Uint8Array = {},
	options?: { readonly headers?: Record<string, string> },
): Record<string, unknown> {
	if (!(body instanceof Uint8Array)) return body;
	const args: Record<string, unknown> = { bytes: body };
	for (const [name, value] of Object.entries(options?.headers ?? {}))
		args[name] = decodeURIComponent(value);
	return args;
}

/**
 * The shell's answer to one folder plugin command for the folder granted at
 * `root`, or `undefined` when `cmd` is not one of the granted folder's.
 */
export async function shellCommand(
	root: string,
	cmd: string,
	args: Record<string, unknown>,
): Promise<{ reply: unknown } | undefined> {
	switch (cmd) {
		case 'run_git': {
			const { code, stdout, stderr } = await runGit(
				root,
				args.args as string[],
				{
					input:
						args.input == null
							? undefined
							: Uint8Array.from(args.input as number[]),
					indexFile: (args.indexFile as string | null) ?? undefined,
				},
			);
			return { reply: { code, stdout: Array.from(stdout), stderr } };
		}
		case 'cancel_git':
			return { reply: null };
		case 'write_folder_file':
			if (!(args.bytes instanceof Uint8Array))
				throw 'write_folder_file takes its bytes as a raw body, not JSON';
			await nodeFs.writeFile(args.path as string, args.bytes, {
				flag: args['create-new'] === 'true' ? 'wx' : 'w',
			});
			return { reply: null };
		case 'rename_folder_path':
			await nodeFs.rename(args.from as string, args.to as string);
			return { reply: null };
		case 'remove_folder_path':
			await nodeFs.rm(args.path as string, {
				recursive: args.recursive === true,
			});
			return { reply: null };
		case 'make_folder_directory':
			await nodeFs.mkdir(args.path as string, { recursive: true });
			return { reply: null };
		default:
			return undefined;
	}
}

/** The plugin's errors are strings carrying the operating system's message. */
async function asPluginError<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (cause) {
		const code = (cause as { code?: string }).code;
		const os = code === 'ENOENT' ? 2 : code === 'EEXIST' ? 17 : 5;
		throw `failed with error: ${String(cause)} (os error ${os})`;
	}
}

/** The read commands of Tauri's fs plugin that a granted folder uses. */
export const fsPlugin = {
	readDir: (path: string) =>
		asPluginError(async () =>
			(await nodeFs.readdir(path, { withFileTypes: true })).map((entry) => ({
				name: entry.name,
				isFile: entry.isFile(),
				isDirectory: entry.isDirectory(),
				isSymlink: entry.isSymbolicLink(),
			})),
		),
	lstat: (path: string) =>
		asPluginError(async () => {
			const stats = await nodeFs.lstat(path);
			return {
				isFile: stats.isFile(),
				isDirectory: stats.isDirectory(),
				isSymlink: stats.isSymbolicLink(),
				size: stats.size,
				mode: stats.mode,
			};
		}),
	readFile: (path: string) =>
		asPluginError(async () => new Uint8Array(await nodeFs.readFile(path))),
};

/**
 * Give this process `navigator.locks`: each request waits behind the last for
 * its name. Returns the function that removes it.
 */
export function installWebLocks(): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { locks: processLocks() },
	});
	return () => {
		if (original === undefined)
			delete (globalThis as { navigator?: unknown }).navigator;
		else Object.defineProperty(globalThis, 'navigator', original);
	};
}

function processLocks() {
	const tails = new Map<string, Promise<unknown>>();
	return {
		request<T>(
			name: string,
			optionsOrWork:
				| { signal?: AbortSignal }
				| ((lock: { name: string }) => Promise<T> | T),
			maybeWork?: (lock: { name: string }) => Promise<T> | T,
		): Promise<T> {
			const work =
				typeof optionsOrWork === 'function'
					? optionsOrWork
					: (maybeWork as (lock: { name: string }) => Promise<T> | T);
			const signal =
				typeof optionsOrWork === 'function' ? undefined : optionsOrWork.signal;
			if (signal?.aborted) return Promise.reject(signal.reason);
			let granted = false;
			const turn = async () => {
				if (signal?.aborted) throw signal.reason;
				granted = true;
				return work({ name });
			};
			const result = (tails.get(name) ?? Promise.resolve()).then(turn, turn);
			tails.set(name, result);
			if (signal === undefined) return result;
			return new Promise<T>((resolve, reject) => {
				signal.addEventListener('abort', () => {
					if (!granted)
						reject(new DOMException('Lock wait aborted', 'AbortError'));
				});
				result.then(resolve, reject);
			});
		},
	};
}
