/**
 * The desktop shell as a page's folder engine reaches it, over real
 * directories, for tests that run the production desktop opener
 * (`@epicenter/folder/tauri`) and everything above it.
 *
 * The shell named each root at startup (`Data`, and `AppData` when given),
 * and the page opens one by name (`open_root`), which answers its path to
 * show. Every storage command names its root. The Bun store over the same
 * directory (`nodeStore`), versioning a note by the sha256 of its bytes as
 * the shell does (`byContent`), answers each, as the plugin answers: its
 * value, or a rejection with the
 * plugin's `FolderError`: `NotFound` for a read of nothing, `Io` for any
 * other storage failure, and `control.refuse`'s root error when unavailable.
 * `control.refuse` answers an open, and every storage command, with the
 * shell's `RootError`, and `control.refuseNext` fails the next writes
 * before anything lands. A test installs `invoke` with `mock.module`, then opens the folder the way
 * its app does. `packages/tauri-plugin-epicenter-folder` tests the plugin's
 * own checks.
 */
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientError } from '@epicenter/definition/contract';
import type { InferError } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { nodeStore } from './device/node-store.js';
import {
	type Store,
	type Version,
	versionedByContent,
} from './device/store.js';
import { hashBytes } from './hash.js';
import type {
	FolderError,
	Root,
	RootError,
	StorageError,
} from './native/bindings.gen.js';

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

/** A store call's value, or a rejection with the plugin's `Io` naming `operation`. */
async function answered<T>(
	operation: string,
	path: string,
	result: Promise<Result<T, InferError<typeof ClientError.Unavailable>>>,
) {
	const { data, error } = await result;
	if (error !== null)
		throw {
			name: 'Io',
			path,
			operation,
			message: String(error.cause),
		} satisfies StorageError;
	return data;
}

/**
 * `store` with a note's version the sha256 of its bytes, as the desktop
 * shell names it (the Bun store names every file by its stamp). A listing
 * and a read hash the notes they answer; a write over a note's hash lands
 * only while the note's bytes still hash to it.
 */
function byContent(store: Store): Store {
	const hash = async (bytes: Uint8Array) => (await hashBytes(bytes)) as Version;
	return {
		...store,
		async list(under) {
			const listed = await store.list(under);
			if (listed.error !== null) return listed;
			const notes = listed.data.filter(({ path }) => versionedByContent(path));
			const read = await store.read(notes.map(({ path }) => path));
			if (read.error !== null) return read;
			const hashes = new Map<string, Version>();
			for (const file of read.data)
				if (!('gone' in file)) hashes.set(file.path, await hash(file.bytes));
			return Ok(
				listed.data.flatMap((file) => {
					if (!versionedByContent(file.path)) return [file];
					const version = hashes.get(file.path);
					return version === undefined ? [] : [{ ...file, version }];
				}),
			);
		},
		async read(paths) {
			const read = await store.read(paths);
			if (read.error !== null) return read;
			return Ok(
				await Promise.all(
					read.data.map(async (file) =>
						'gone' in file || !versionedByContent(file.path)
							? file
							: { ...file, version: await hash(file.bytes) },
					),
				),
			);
		},
		async write(path, bytes, over) {
			if (!versionedByContent(path) || over === 'absent')
				return resolved(path, bytes, await store.write(path, bytes, over));
			const [there] = await storeRead(store, path);
			if (there === undefined || 'gone' in there || (await hash(there.bytes)) !== over)
				return Ok('stale');
			return resolved(path, bytes, await store.write(path, bytes, there.version));
		},
	};
	async function resolved(
		path: string,
		bytes: Uint8Array | null,
		written: Awaited<ReturnType<Store['write']>>,
	) {
		if (written.error !== null || bytes === null) return written;
		if (written.data === 'stale' || !versionedByContent(path)) return written;
		return Ok(await hash(bytes));
	}
}

async function storeRead(store: Store, path: string) {
	const read = await store.read([path]);
	return read.error === null ? read.data : [];
}

/** A new, empty directory to name as a root, resolved to the spelling the shell reports. */
export async function namedDirectory(prefix = 'named-'): Promise<string> {
	return nodeFs.realpath(await nodeFs.mkdtemp(join(tmpdir(), prefix)));
}

/**
 * The shell, with its data root named at `roots.Data` and its AppData root
 * at `roots.AppData`, when given.
 */
export function createNamedShell(roots: { Data: string; AppData?: string }) {
	const calls: ShellCall[] = [];
	const control = {
		/** The shell's refusal of `root`, if any, to an open or a storage command. */
		refuse: (_root: Root): RootError | undefined => undefined,
		/** How many upcoming writes fail before anything lands. */
		refuseNext: 0,
	};
	const stores = new Map<Root, Store>();
	for (const [root, path] of Object.entries(roots) as [
		Root,
		string | undefined,
	][])
		if (path !== undefined) stores.set(root, byContent(nodeStore(path)));
	/** The storage of the root a call named, or the plugin's refusal. */
	function storageFor(args: Record<string, unknown>): Store {
		const named = args.root as Root;
		const refused = control.refuse(named);
		if (refused !== undefined) throw refused satisfies FolderError;
		const store = stores.get(named);
		if (store === undefined)
			throw { name: 'NotNamed', root: named } satisfies FolderError;
		return store;
	}

	const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
		async reveal_root() {
			return null;
		},
		async open_root(args) {
			const named = args.root as Root;
			const refused = control.refuse(named);
			if (refused !== undefined) throw refused;
			const path = roots[named];
			if (path === undefined)
				throw { name: 'NotNamed', root: named } satisfies RootError;
			return path;
		},
		list_folder: (args) =>
			answered('list', '', storageFor(args).list(args.under as string[])),
		async read_folder_file(args) {
			const path = args.path as string;
			const [read] = await answered(
				'read',
				path,
				storageFor(args).read([path]),
			);
			if (read === undefined || 'gone' in read)
				throw { name: 'NotFound', path } satisfies StorageError;
			// The page names a note by its bytes, and anything else by this stamp.
			const { bytes } = read;
			const stamp = versionedByContent(path) ? 'v1:note' : read.version;
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
			const expected = args.expected as string;
			const parsed =
				expected === 'absent'
					? 'absent'
					: (expected.slice(expected.indexOf(':') + 1) as Version);
			if (control.refuseNext > 0) {
				control.refuseNext -= 1;
				throw {
					name: 'Io',
					path,
					operation: 'write',
					message: 'the disk refused the write',
				} satisfies StorageError;
			}
			// The shell answers the stamp that landed, which names an attachment.
			const outcome = await answered(
				'write',
				path,
				storageFor(args).write(
					path,
					args.remove === 'true' ? null : (args.bytes as Uint8Array),
					parsed,
				),
			);
			return outcome === 'stale' ? outcome : { landed: outcome ?? '' };
		},
	};

	return {
		root: roots.Data,
		calls,
		control,
		/** The text at a path in the data root, or undefined when there is no file. */
		async text(path: string) {
			return nodeFs
				.readFile(join(roots.Data, path), 'utf8')
				.catch(() => undefined);
		},
		/** Another program writes the data root. */
		async write(path: string, text: string | Uint8Array) {
			await nodeFs.mkdir(join(roots.Data, path, '..'), { recursive: true });
			await nodeFs.writeFile(join(roots.Data, path), text);
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

export type NamedShell = ReturnType<typeof createNamedShell>;
