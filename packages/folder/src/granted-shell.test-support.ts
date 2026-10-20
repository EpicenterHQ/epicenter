/**
 * The desktop shell as a page's folder engine reaches it, over a real
 * directory, for tests that run the production desktop opener
 * (`@epicenter/folder/tauri`) and everything above it.
 *
 * The shell grants the window one directory (`grant_directory`). The page's
 * storage is the folder plugin's commands, one per storage method
 * (ADR-0581). Here the Bun directory storage over `node:fs`
 * (`directory-store.ts`), whose outcomes the plugin's `storage.rs` matches,
 * answers each storage command. A command answers as the plugin does: its
 * value, or a rejection with the plugin's `StorageError`, where a failure the
 * shell reports changed nothing and so is `Io`, never `Unconfirmed`. A grant
 * sweeps staged files an hour old from the scratch directory beside the
 * root, as the shell's does. A test installs `invoke` with `mock.module`,
 * then opens the folder the way its app does.
 *
 * A data file is published as the shell publishes one: its bytes are staged
 * in `.<name>.epicenter-scratch` beside the root, never inside it, and
 * renamed over the path once the path is checked, or the path is checked and
 * removed. A test decides when such a
 * change is made, before the check (`beforeChange`), whether it fails
 * before it lands (`refuseNext`), what happens once it landed
 * (`afterChange`), and whether its reply is lost after it landed
 * (`loseReplies`, or a throw in `afterChange`): the command then rejects
 * with something other than a `StorageError`, as a lost reply does. A
 * directory removal is no data change: it can lose its reply after it
 * landed (`loseDirectoryReplies`), and nothing else. Reads of a path can
 * fail (`failReads`). `packages/tauri-plugin-epicenter-folder` tests the
 * plugin's own checks.
 */
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Result } from 'wellcrafted/result';
import { isStaleScratch } from './boundary.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import type { DirectoryPrimitives } from './directory-primitives.js';
import { createDirectoryStorage } from './directory-store.js';
import { describe, type FileError } from './errors.js';
import type { StorageError } from './native/bindings.gen.js';
import { scratchDirectory } from './native/directory.js';

export type ShellCall = { cmd: string; args: Record<string, unknown> };

/**
 * The arguments of one `invoke`, as the shell reads them. A command that takes
 * a raw body (`put_folder_file`) carries the rest in percent-encoded headers,
 * decoded here beside the body as `bytes`.
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

/** A data file the page wrote or removed, folder-relative. */
export type DataChange =
	| { kind: 'write'; path: string; text: string }
	| { kind: 'remove'; path: string };

/** A storage failure as the plugin answers it. */
function storageError(error: FileError): StorageError {
	switch (error.name) {
		case 'InvalidPath':
			return { name: error.name, path: error.path, reason: error.reason };
		case 'NotFound':
		case 'NotAFile':
		case 'NotADirectory':
		case 'DirectoryNotEmpty':
			return { name: error.name, path: error.path };
		case 'Io':
		case 'Unconfirmed':
			return {
				name: 'Io',
				path: error.path,
				operation: error.operation,
				message: describe(error.cause),
			};
		case 'Closed':
			throw new Error('the shell never answers Closed');
	}
}

/** A storage call's value, or a rejection with the plugin's answer. */
async function answered<T>(result: Promise<Result<T, FileError>>) {
	const { data, error } = await result;
	if (error !== null) throw storageError(error);
	return data;
}

/** A new, empty directory to grant, resolved to the spelling the shell reports. */
export async function grantedDirectory(prefix = 'granted-'): Promise<string> {
	return nodeFs.realpath(await nodeFs.mkdtemp(join(tmpdir(), prefix)));
}

/** The shell, granting the directory at `root`. */
export function createGrantedShell(root: string) {
	const calls: ShellCall[] = [];
	/** Every data change that landed, in order. */
	const changes: DataChange[] = [];
	const control = {
		/** The installed app and directory handed to this window. */
		window: undefined as { app: string; folder: string } | null | undefined,
		/** The shell's answer to `grant_directory`; throw to refuse. */
		grant: (): unknown => ({ root }),
		/** Runs before each data change is checked and made; await in it to hold the change. */
		beforeChange: undefined as
			| ((change: DataChange) => Promise<void> | void)
			| undefined,
		/** Runs after each data change landed; throw in it to lose the reply. */
		afterChange: undefined as ((change: DataChange) => void) | undefined,
		/** How many upcoming data changes fail before anything lands. */
		refuseNext: 0,
		/** How many upcoming data changes land and then lose their reply. */
		loseReplies: 0,
		/**
		 * How many upcoming directory removals land and then lose their reply.
		 * A directory removal is no data change: the controls above never
		 * reach it.
		 */
		loseDirectoryReplies: 0,
		/** Folder-relative paths whose reads fail, as a disk that cannot be read. */
		failReads: new Set<string>(),
	};
	const relative = (path: string) =>
		path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
	/** Data paths whose change landed and whose reply is to be lost, with why. */
	const lostReplies = new Map<string, unknown>();

	/** One data change, under the test's controls. */
	async function change(described: DataChange, make: () => Promise<void>) {
		await control.beforeChange?.(described);
		if (control.refuseNext > 0) {
			control.refuseNext -= 1;
			throw new Error(
				`'${described.path}' could not be written: the disk refused the write`,
			);
		}
		await make();
		changes.push(described);
		try {
			control.afterChange?.(described);
		} catch (lost) {
			lostReplies.set(described.path, lost);
		}
		if (control.loseReplies > 0) {
			control.loseReplies -= 1;
			lostReplies.set(described.path, 'the reply never reached the window');
		}
	}

	/**
	 * The shell's file system: `node:fs`, with each data change, the rename
	 * of a staged file over its path or a removal, under the test's controls.
	 */
	const files: DirectoryPrimitives = {
		...nodeDirectoryPrimitives,
		async rename(from, to, expected) {
			const text = new TextDecoder().decode(await nodeFs.readFile(from));
			await change({ kind: 'write', path: relative(to), text }, () =>
				nodeDirectoryPrimitives.rename(from, to, expected),
			);
		},
		async remove(path, options) {
			// A removal with no expectation is the storage's own: a staged
			// file, a directory a put made, or `rmdir`'s directory.
			if (options?.expected === undefined)
				return nodeDirectoryPrimitives.remove(path, options);
			await change({ kind: 'remove', path: relative(path) }, () =>
				nodeDirectoryPrimitives.remove(path, options),
			);
		},
	};
	// Staged beside the root, as `storage.rs` stages: the authored folder
	// gets nothing but the files saved, and no `.git`.
	const scratch = scratchDirectory(root);
	const storage = createDirectoryStorage({ root, primitives: files, scratch });

	/** Remove the staged files a stopped save left an hour or more ago. */
	async function sweep() {
		const now = Date.now();
		const entries = await nodeFs
			.readdir(scratch, { withFileTypes: true })
			.catch(() => []);
		for (const entry of entries)
			if (entry.isFile() && isStaleScratch(entry.name, now))
				await nodeFs.rm(join(scratch, entry.name), { force: true });
	}

	const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
		window_folder() {
			if (control.window === undefined) throw new Error('No folder was handed to this window');
			return control.window;
		},
		async grant_directory() {
			const granted = control.grant();
			await sweep();
			return granted;
		},
		list_folder: () => answered(storage.list()),
		read_folder_children: (args) =>
			answered(storage.children(args.directory as string)),
		async read_folder_file(args) {
			const path = args.path as string;
			if (control.failReads.has(path))
				throw {
					name: 'Io',
					path,
					operation: 'read',
					message: 'the disk could not be read (os error 5)',
				} satisfies StorageError;
			const { bytes } = await answered(storage.read(path));
			// The raw response arrives as an `ArrayBuffer`.
			return bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			);
		},
		async put_folder_file(args) {
			const path = args.path as string;
			// The bytes are the raw body; a JSON body is refused, as the shell
			// refuses one that is not an array of bytes.
			const bytes = args.bytes;
			if (!(bytes instanceof Uint8Array))
				throw {
					name: 'Io',
					path,
					operation: 'write',
					message: 'put_folder_file takes its bytes as a raw body',
				} satisfies StorageError;
			const ifMatch = args['if-match'];
			const outcome = await answered(
				storage.put(
					path,
					args.remove === 'true' ? null : bytes,
					typeof ifMatch === 'string' ? ifMatch : null,
				),
			);
			if (lostReplies.has(path)) {
				const lost = lostReplies.get(path);
				lostReplies.delete(path);
				throw lost;
			}
			return outcome;
		},
		async make_folder_directory(args) {
			await answered(storage.mkdir(args.path as string));
			return null;
		},
		async remove_folder_directory(args) {
			await answered(storage.rmdir(args.path as string));
			if (control.loseDirectoryReplies > 0) {
				control.loseDirectoryReplies -= 1;
				throw new Error('the reply never reached the window');
			}
			return null;
		},
	};

	return {
		root,
		/** Where saves are staged: `.<name>.epicenter-scratch` beside the root. */
		scratch,
		calls,
		changes,
		control,
		/** The kind of each data change, in order. */
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
		/** In place of Tauri's `invoke`, for the folder plugin's commands. */
		async invoke(
			cmd: string,
			body?: Record<string, unknown> | Uint8Array,
			options?: { headers?: Record<string, string> },
		): Promise<unknown> {
			const args = shellArguments(body, options);
			const name = cmd.replace('plugin:epicenter-folder|', '');
			calls.push({ cmd: name, args });
			const command = commands[name];
			if (command === undefined) throw `no such command ${name}`;
			return command(args);
		},
	};
}

export type GrantedShell = ReturnType<typeof createGrantedShell>;
