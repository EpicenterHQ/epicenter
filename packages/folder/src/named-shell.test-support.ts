/**
 * The desktop shell as a page's folder engine reaches it, over real
 * directories, for tests that run the production desktop opener
 * (`@epicenter/folder/tauri`) and everything above it.
 *
 * The shell named each root at startup (`Data`, and `AppData` when given),
 * and the page opens one by name (`open_root`), which answers its path to
 * show. Every storage command names its root. The Bun store over the same
 * directory (`nodeStore`)
 * answers each, as the plugin answers: its value, or a rejection with the
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
import {
	type ClientError,
	storedWithLfs,
} from '@epicenter/definition/contract';
import type { InferError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { nodeStore } from './device/node-store.js';
import type { BlobId, Store } from './device/store.js';
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

/** The shell's stamp of the file at `at` (`stamp_of` in the folder core), or undefined when none is there. */
async function stampAt(at: string) {
	const stats = await nodeFs.stat(at, { bigint: true }).catch(() => undefined);
	if (stats === undefined) return undefined;
	return `v1:${stats.size}:${stats.mtimeNs}:${stats.dev}:${stats.ino}`;
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
	const stores = new Map<Root, { store: Store; path: string }>();
	for (const [root, path] of Object.entries(roots) as [
		Root,
		string | undefined,
	][])
		if (path !== undefined) stores.set(root, { store: nodeStore(path), path });
	/** The storage of the root a call named, and its directory, or the plugin's refusal. */
	function rootFor(args: Record<string, unknown>) {
		const named = args.root as Root;
		const refused = control.refuse(named);
		if (refused !== undefined) throw refused satisfies FolderError;
		const store = stores.get(named);
		if (store === undefined)
			throw { name: 'NotNamed', root: named } satisfies FolderError;
		return store;
	}
	const storageFor = (args: Record<string, unknown>): Store =>
		rootFor(args).store;

	const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
		async reveal_root() {
			return null;
		},
		async open_root(args) {
			const named = args.root as Root;
			const refused = control.refuse(named);
			if (refused !== undefined) throw refused;
			const path = typeof named === 'string' ? roots[named] : undefined;
			if (path === undefined)
				throw { name: 'NotNamed', root: named } satisfies RootError;
			return path;
		},
		async list_folder(args) {
			const { store, path: directory } = rootFor(args);
			const listed = await answered(
				'list',
				'',
				store.list(args.under as string[]),
			);
			// The shell names an attachment by its stamp, and anything else by its blob id.
			return Promise.all(
				listed.map(async (file) =>
					storedWithLfs(file.path)
						? {
								...file,
								version:
									(await stampAt(join(directory, file.path))) ?? file.version,
							}
						: file,
				),
			);
		},
		async read_folder_file(args) {
			const path = args.path as string;
			const [read] = await answered(
				'read',
				path,
				storageFor(args).read([path]),
			);
			if (read === undefined || 'gone' in read)
				throw { name: 'NotFound', path } satisfies StorageError;
			// The shell answers every file's stamp beside its bytes.
			const { bytes } = read;
			const stamp =
				(await stampAt(join(rootFor(args).path, path))) ?? 'v1:gone';
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
			if (control.refuseNext > 0) {
				control.refuseNext -= 1;
				throw {
					name: 'Io',
					path,
					operation: 'write',
					message: 'the disk refused the write',
				} satisfies StorageError;
			}
			const { store, path: directory } = rootFor(args);
			const [there] = await answered('read', path, store.read([path]));
			const now = there === undefined || 'gone' in there ? null : there.version;
			// `absent`, `blob:<id>`, `stamp:<stamp>` (checked against the file's stamp), or `any`.
			let expect: BlobId | null;
			if (expected === 'absent') expect = null;
			else if (expected === 'any') expect = now;
			else if (expected.startsWith('blob:'))
				expect = expected.slice(5) as BlobId;
			else if (expected.startsWith('stamp:'))
				expect =
					(await stampAt(join(directory, path))) === expected.slice(6) &&
					now !== null
						? now
						: ('0'.repeat(40) as BlobId);
			else
				throw {
					name: 'Io',
					path,
					operation: 'write',
					message: `expected is ${expected}`,
				} satisfies StorageError;
			const put = await store.put(
				path,
				args.remove === 'true' ? null : (args.bytes as Uint8Array),
				expect,
			);
			if (put.error?.name === 'Moved') return 'stale';
			await answered(
				'write',
				path,
				Promise.resolve(
					put as Result<unknown, InferError<typeof ClientError.Unavailable>>,
				),
			);
			// The shell answers the stamp that landed.
			return { landed: (await stampAt(join(directory, path))) ?? '' };
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
