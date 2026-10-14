/**
 * The desktop shell as the page's folder engine reaches it, over a real
 * directory, for tests that run the production desktop opener
 * (`@epicenter/folder/tauri`) and everything above it.
 *
 * The shell grants the window one directory (`grant_directory`). The page
 * reads it through Tauri's fs plugin, changes it through the folder plugin's
 * commands, and runs `git` through `run_git`. Here `node:fs` and the system
 * `git` stand in for both plugins, failing as they fail: an fs error is text
 * carrying the operating system's message, and a refused change is text. A
 * test installs `invoke` and the fs plugin with `mock.module`, then opens the
 * folder the way the desktop workspace does.
 *
 * A data file is published as the engine publishes one: its bytes are staged
 * under `.git/epicenter/scratch` and renamed over the path, or the path is
 * removed. A test decides when such a change is made (`beforeChange`),
 * whether it fails before it lands (`refuseNext`), and whether its reply is
 * lost after it landed (`loseReplies`). Reads of a path can fail
 * (`failReads`). The folder's declaration, `epicenter.json`, is outside every
 * control. Nothing here is the Rust shell; `packages/tauri-plugin-epicenter-folder`
 * tests what it allows.
 */
import * as nodeFs from 'node:fs/promises';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner } from '../../../../../packages/folder/src/git/native-host.js';

export type ShellCall = { cmd: string; args: Record<string, unknown> };

/** A data file the page wrote or removed, folder-relative. */
export type DataChange =
	| { kind: 'write'; path: string; text: string }
	| { kind: 'remove'; path: string };

const DECLARATION = 'epicenter.json';
const SCRATCH = '/.git/epicenter/scratch/';

/** The plugins' errors are text carrying the operating system's message. */
async function asPluginError<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (cause) {
		const code = (cause as { code?: string }).code;
		const os = code === 'ENOENT' ? 2 : code === 'EEXIST' ? 17 : 5;
		throw `failed with error: ${String(cause)} (os error ${os})`;
	}
}

/** A new, empty directory to grant, resolved to the spelling the shell reports. */
export async function grantedDirectory(): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), 'whispering-granted-')));
}

export function createGrantedShell(root: string, scope: string) {
	const calls: ShellCall[] = [];
	/** Every data change that landed, in order. */
	const changes: DataChange[] = [];
	const control = {
		/** The shell's answer to `grant_directory`; throw to refuse. */
		grant: (): unknown => ({
			root,
			branch: 'main',
			authorName: 'Whispering',
			authorEmail: 'whispering@localhost',
		}),
		/** Runs before each data change is made; await in it to hold the change. */
		beforeChange: undefined as
			| ((change: DataChange) => Promise<void>)
			| undefined,
		/** How many upcoming data changes fail before anything lands. */
		refuseNext: 0,
		/** How many upcoming data changes land and then lose their reply. */
		loseReplies: 0,
		/** Folder-relative paths whose reads fail, as a disk that cannot be read. */
		failReads: new Set<string>(),
	};
	const relative = (path: string) =>
		path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
	const run = createGitRunner(root);

	/** One data change, under the test's controls. */
	async function change(described: DataChange, make: () => Promise<void>) {
		if (described.path === DECLARATION) return make();
		await control.beforeChange?.(described);
		if (control.refuseNext > 0) {
			control.refuseNext -= 1;
			throw `'${described.path}' could not be written: the disk refused the write`;
		}
		await make();
		changes.push(described);
		if (control.loseReplies > 0) {
			control.loseReplies -= 1;
			throw 'the reply never reached the window';
		}
	}

	const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
		grant_directory: () => control.grant(),
		async run_git(args) {
			const result = await run(args.args as string[], {
				input:
					args.input === null
						? undefined
						: new Uint8Array(args.input as number[]),
				env:
					args.indexFile === null
						? undefined
						: { GIT_INDEX_FILE: args.indexFile as string },
				allowFailure: true,
			});
			return {
				code: result.code,
				stdout: Array.from(result.stdout),
				stderr: result.stderr,
			};
		},
		cancel_git: () => null,
		async write_folder_file(args) {
			// Staged bytes, or the engine's private files under `.git`. A data
			// file reaches its path only by the rename that follows.
			await asPluginError(() =>
				nodeFs.writeFile(
					args.path as string,
					new Uint8Array(args.bytes as number[]),
					{ flag: args.createNew ? 'wx' : 'w' },
				),
			);
			return null;
		},
		async rename_folder_path(args) {
			const from = args.from as string;
			const to = args.to as string;
			const rename = () => asPluginError(() => nodeFs.rename(from, to));
			if (!from.includes(SCRATCH) || to.includes('/.git/')) {
				await rename();
				return null;
			}
			const text = new TextDecoder().decode(await nodeFs.readFile(from));
			await change({ kind: 'write', path: relative(to), text }, rename);
			return null;
		},
		async remove_folder_path(args) {
			const path = args.path as string;
			const remove = () =>
				asPluginError(() =>
					nodeFs.rm(path, { recursive: args.recursive === true }),
				);
			if (path.includes('/.git/')) {
				await remove();
				return null;
			}
			await change({ kind: 'remove', path: relative(path) }, remove);
			return null;
		},
		async make_folder_directory(args) {
			await asPluginError(() =>
				nodeFs.mkdir(args.path as string, { recursive: true }),
			);
			return null;
		},
	};

	return {
		root,
		scope,
		calls,
		changes,
		control,
		/** The data changes, without the folder's declaration. */
		get kinds() {
			return changes.map((change) => change.kind);
		},
		/** The text at a folder-relative path, or undefined when there is no file. */
		async text(path: string) {
			return nodeFs.readFile(join(root, path), 'utf8').catch(() => undefined);
		},
		/** Another program writes the folder. */
		async write(path: string, text: string | Uint8Array) {
			await nodeFs.mkdir(join(root, path, '..'), { recursive: true });
			await nodeFs.writeFile(join(root, path), text);
		},
		/** In place of Tauri's `invoke`. */
		async invoke(cmd: string, args: Record<string, unknown> = {}) {
			const name = cmd.replace('plugin:epicenter-folder|', '');
			calls.push({ cmd: name, args });
			const command = commands[name];
			if (command === undefined) throw `no such command ${name}`;
			return command(args);
		},
		/** In place of `@tauri-apps/plugin-fs`. */
		fs: {
			readDir: (path: string) =>
				asPluginError(async () =>
					(await nodeFs.readdir(path, { withFileTypes: true })).map(
						(entry) => ({
							name: entry.name,
							isFile: entry.isFile(),
							isDirectory: entry.isDirectory(),
							isSymlink: entry.isSymbolicLink(),
						}),
					),
				),
			lstat: (path: string) =>
				asPluginError(async () => {
					const stats = await nodeFs.lstat(path);
					return {
						isFile: stats.isFile(),
						isDirectory: stats.isDirectory(),
						isSymlink: stats.isSymbolicLink(),
						size: stats.size,
						mode: null,
					};
				}),
			readFile: (path: string) =>
				asPluginError(async () => {
					if (control.failReads.has(relative(path)))
						throw Object.assign(new Error('the disk could not be read'), {
							code: 'EIO',
						});
					return new Uint8Array(await nodeFs.readFile(path));
				}),
		},
	};
}

export type GrantedShell = ReturnType<typeof createGrantedShell>;
