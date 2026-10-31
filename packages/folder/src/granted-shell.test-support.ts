/**
 * The desktop shell as a page's folder engine reaches it, over a real
 * directory, for tests that run the production desktop opener
 * (`@epicenter/folder/tauri`) and everything above it.
 *
 * The shell bound the window one directory before the window existed, and
 * the page opens it (`open_folder`), naming none or its path; other roots
 * open only when allowed, as Tauri's file-system scope allows them. The page's storage is the
 * folder plugin's commands, one per storage method
 * (ADR-0581). Here the Bun directory storage over `node:fs`
 * (`directory-store.ts`), whose outcomes the plugin's `storage.rs` matches,
 * answers each storage command. A command answers as the plugin does: its
 * value, or a rejection with the plugin's `StorageError`, where a failure the
 * shell reports changed nothing and so is `Io`, never `Unconfirmed`. An open
 * sweeps staged files an hour old from the scratch directory inside the
 * root, as the shell's does. A test installs `invoke` with `mock.module`,
 * then opens the folder the way its app does.
 *
 * A data file is published as the shell publishes one: its bytes are staged
 * in the root's `.epicenter/scratch`, which no listing shows, and
 * renamed over the path once the path is checked, or the path is checked and
 * removed. A test decides when such a
 * change is made, before the check (`beforeChange`), whether it fails
 * before it lands (`refuseNext`), what happens once it landed
 * (`afterChange`), and whether its reply is lost after it landed
 * (`loseReplies`, or a throw in `afterChange`): the command then rejects
 * with something other than a `StorageError`, as a lost reply does. Reads of a path can
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

/** A new, empty directory to bind, resolved to the spelling the shell reports. */
export async function grantedDirectory(prefix = 'granted-'): Promise<string> {
	return nodeFs.realpath(await nodeFs.mkdtemp(join(tmpdir(), prefix)));
}

/**
 * The shell, with the directory at `root` bound to the window and the
 * directories at `grants` allowed beside it, as Tauri's file-system scope
 * allows a default or a picked folder: the page opens one by its path
 * (`open_folder`), which answers `Missing` for one that is not there unless
 * asked to make it, then names it in a command's `root`. Any other root is
 * refused as the plugin refuses it. Allowed roots are plain storage, outside
 * the test's change controls; `opened` lists every open, with its channel.
 */
export function createGrantedShell(
	root: string,
	{ grants = [] }: { grants?: readonly string[] } = {},
) {
	/** Each `open_folder`: the root asked for (null for the window's own) and its channel. */
	const opened: { root: string | null; onChange: unknown }[] = [];
	/** Allowed roots the page has opened. */
	const admitted = new Set<string>();
	const calls: ShellCall[] = [];
	/** Every data change that landed, in order. */
	const changes: DataChange[] = [];
	const control = {
		/** The shell's answer to `open_folder`; throw to refuse. */
		open: (): unknown => null,
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
		/** Folder-relative paths whose reads fail, as a disk that cannot be read. */
		failReads: new Set<string>(),
	};
	const relative = (path: string) =>
		path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
	/** Data paths whose change landed and whose reply is to be lost, with why. */
	const lostReplies = new Map<string, unknown>();

	/** One data change, under the test's controls. */
	async function change<T>(
		described: DataChange,
		make: () => Promise<T>,
	): Promise<T> {
		await control.beforeChange?.(described);
		if (control.refuseNext > 0) {
			control.refuseNext -= 1;
			throw new Error(
				`'${described.path}' could not be written: the disk refused the write`,
			);
		}
		const result = await make();
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
		return result;
	}

	/**
	 * The shell's file system: `node:fs`, with each data change, the rename
	 * of a staged file over its path or a removal, under the test's controls.
	 */
	const files: DirectoryPrimitives = {
		...nodeDirectoryPrimitives,
		async rename(from, to, expected) {
			const text = new TextDecoder().decode(await nodeFs.readFile(from));
			return change({ kind: 'write', path: relative(to), text }, () =>
				nodeDirectoryPrimitives.rename(from, to, expected),
			);
		},
		async remove(path, options) {
			// A removal with no expectation is the storage's own: a staged
			// file, or a directory a put made.
			if (options?.expected === undefined)
				return nodeDirectoryPrimitives.remove(path, options);
			await change({ kind: 'remove', path: relative(path) }, () =>
				nodeDirectoryPrimitives.remove(path, options),
			);
		},
	};
	// Staged in `.epicenter`, as `storage.rs` stages: the authored folder
	// gets nothing but the files saved and `.epicenter`, and no `.git`.
	const scratch = scratchDirectory(root);
	const storage = createDirectoryStorage({ root, primitives: files, scratch });
	const granted = new Map(
		grants.map((grant) => [
			grant,
			createDirectoryStorage({
				root: grant,
				primitives: nodeDirectoryPrimitives,
				scratch: scratchDirectory(grant),
			}),
		]),
	);
	/** The storage of the root a call named, or the plugin's refusal. */
	function storageFor(args: Record<string, unknown>) {
		const named = args.root;
		if (named === undefined || named === null || named === root) return storage;
		const found = granted.get(named as string);
		if (found !== undefined && admitted.has(named as string)) return found;
		throw {
			name: 'Io',
			path: (args.path as string | undefined) ?? '',
			operation: 'open',
			message: `NotGranted { root: ${JSON.stringify(named)} }`,
		} satisfies StorageError;
	}

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
		async open_folder(args) {
			const named = (args.root as string | null | undefined) ?? null;
			opened.push({ root: named, onChange: args.onChange });
			const answer = control.open();
			if (named === null || named === root) {
				await sweep();
				// The shell answers the root it watches.
				return answer === null ? root : answer;
			}
			if (!granted.has(named)) throw { name: 'NotGranted', root: named };
			const exists = await nodeFs
				.stat(named)
				.then((stats) => stats.isDirectory())
				.catch(() => false);
			if (!exists && args.create !== true) throw { name: 'Missing' };
			await nodeFs.mkdir(named, { recursive: true });
			admitted.add(named);
			return named;
		},
		/** The canonical path of an allowed folder, as Tauri's scope matches both spellings. */
		async resolve_folder(args) {
			const named = args.root as string;
			const real = await nodeFs.realpath(named).catch(() => undefined);
			if (!granted.has(named) && (real === undefined || !granted.has(real)))
				throw { name: 'NotGranted', root: named };
			if (real === undefined) throw { name: 'Missing' };
			return real;
		},
		list_folder: (args) => answered(storageFor(args).list()),
		async read_folder_file(args) {
			const path = args.path as string;
			if (control.failReads.has(path))
				throw {
					name: 'Io',
					path,
					operation: 'read',
					message: 'the disk could not be read (os error 5)',
				} satisfies StorageError;
			const { bytes, stamp } = await answered(storageFor(args).read(path));
			// The raw response arrives as one `ArrayBuffer`: the stamp, a zero
			// byte, then the file bytes, as the plugin sends it.
			const header = new TextEncoder().encode(stamp);
			const response = new Uint8Array(header.length + 1 + bytes.length);
			response.set(header);
			response.set(bytes, header.length + 1);
			return response.buffer;
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
			const expected = args.expected;
			if (typeof expected !== 'string')
				throw {
					name: 'Io',
					path,
					operation: 'write',
					message: 'put_folder_file needs the expected header',
				} satisfies StorageError;
			const outcome = await answered(
				storageFor(args).put(
					path,
					args.remove === 'true' ? null : bytes,
					expected === 'any' || expected === 'absent' || expected === 'present'
						? expected
						: { sha256: expected },
				),
			);
			if (lostReplies.has(path)) {
				const lost = lostReplies.get(path);
				lostReplies.delete(path);
				throw lost;
			}
			return outcome;
		},
	};

	return {
		root,
		opened,
		/** Where saves are staged: `.epicenter/scratch` inside the root. */
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
