/**
 * The desktop shell as a page's folder engine reaches it, over real
 * directories, for tests that run the production desktop opener
 * (`@epicenter/folder/tauri`) and everything above it.
 *
 * The shell named each root at startup (`Data`, and `AppData` when given),
 * and the page opens one by name (`open_root`), which makes its folder when
 * nothing is there; `root_path` alone answers the path to show. Every
 * storage command names its root, as the plugin's do, and reaches only a
 * root the page opened; its storage commands are one per storage method
 * (ADR-0581). Here the Bun store over the same directory (`nodeStore`)
 * answers each, as the plugin answers: its value, or a rejection with the
 * plugin's `FolderError`: `NotFound` for a read of nothing, `Io` for any
 * other storage failure, and the root's `RootError` (`NotOpen`, or
 * `control.refuse`'s, such as `Disconnected`) when the root cannot be used.
 * `control.refuse` answers an open, and every storage command, with the
 * shell's `RootError`, and `control.refuseNext` fails the next writes
 * before anything lands. A
 * test installs `invoke` with `mock.module`, then opens the folder the way
 * its app does. `packages/tauri-plugin-epicenter-folder` tests the plugin's
 * own checks.
 */
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientError, Version } from '@epicenter/definition/contract';
import type { InferError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { nodeStore } from './device/node-store.js';
import type { DeviceExpectation, DeviceStore } from './device/store.js';
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

/** A new, empty directory to name as a root, resolved to the spelling the shell reports. */
export async function namedDirectory(prefix = 'named-'): Promise<string> {
	return nodeFs.realpath(await nodeFs.mkdtemp(join(tmpdir(), prefix)));
}

/**
 * The shell, with its data root named at `roots.Data` and its AppData root
 * at `roots.AppData`, when given. `opened` lists every open, with its
 * channel.
 */
export function createNamedShell(roots: { Data: string; AppData?: string }) {
	/** Each `open_root`: the root asked for and its channel. */
	const opened: { root: Root; onChange: unknown }[] = [];
	/** The roots the page has opened. */
	const open = new Set<Root>();
	const calls: ShellCall[] = [];
	const control = {
		/** The shell's refusal of `root`, if any, to an open or a storage command. */
		refuse: (_root: Root): RootError | undefined => undefined,
		/** How many upcoming writes fail before anything lands. */
		refuseNext: 0,
	};
	const stores = new Map<Root, DeviceStore>();
	for (const [root, path] of Object.entries(roots) as [
		Root,
		string | undefined,
	][])
		if (path !== undefined) stores.set(root, nodeStore(path));
	/** The storage of the root a call named, or the plugin's refusal. */
	function storageFor(args: Record<string, unknown>): DeviceStore {
		const named = args.root as Root;
		const refused = control.refuse(named);
		if (refused !== undefined) throw refused satisfies FolderError;
		const store = stores.get(named);
		if (store === undefined)
			throw { name: 'NotNamed', root: named } satisfies FolderError;
		if (!open.has(named))
			throw { name: 'NotOpen', root: named } satisfies FolderError;
		return store;
	}

	const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
		async open_root(args) {
			const named = args.root as Root;
			opened.push({ root: named, onChange: args.onChange });
			const refused = control.refuse(named);
			if (refused !== undefined) throw refused;
			const path = roots[named];
			if (path === undefined)
				throw { name: 'NotNamed', root: named } satisfies RootError;
			// Whatever is there opens; the folder is made when nothing is.
			await nodeFs.mkdir(path, { recursive: true });
			open.add(named);
			return null;
		},
		/** Display only: opens, reads and makes nothing. */
		root_path(args) {
			const named = args.root as Root;
			const path = roots[named];
			if (path === undefined)
				throw { name: 'NotNamed', root: named } satisfies RootError;
			return path;
		},
		list_folder: (args) => answered('list', '', storageFor(args).list()),
		async read_folder_file(args) {
			const path = args.path as string;
			const read = await answered('read', path, storageFor(args).read(path));
			if (read === null)
				throw { name: 'NotFound', path } satisfies StorageError;
			const { bytes, stamp } = read;
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
			// As `storage::Expectation::parse` reads it: a keyword, or a tagged hash.
			const hash = /^sha256:([0-9a-f]{64})$/.exec(expected)?.[1];
			const parsed: DeviceExpectation | undefined =
				expected === 'absent'
					? expected
					: hash !== undefined
						? { sha256: hash as Version }
						: undefined;
			if (parsed === undefined)
				throw {
					name: 'Io',
					path,
					operation: 'write',
					message: `expected is ${JSON.stringify(expected)}, not absent, or sha256: and a SHA-256`,
				} satisfies StorageError;
			if (control.refuseNext > 0) {
				control.refuseNext -= 1;
				throw {
					name: 'Io',
					path,
					operation: 'write',
					message: 'the disk refused the write',
				} satisfies StorageError;
			}
			return answered(
				'write',
				path,
				storageFor(args).write(
					path,
					args.remove === 'true' ? null : bytes,
					parsed,
				),
			);
		},
	};

	return {
		root: roots.Data,
		opened,
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
