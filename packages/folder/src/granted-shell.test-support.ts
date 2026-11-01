/**
 * The desktop shell as a page's folder engine reaches it, over a real
 * directory, for tests that run the production desktop opener
 * (`@epicenter/folder/tauri`) and everything above it.
 *
 * The shell bound the window one directory before the window existed, and
 * the page opens it (`open_folder`) by its path; other roots open only when
 * allowed, as Tauri's file-system scope allows them. Every command names its
 * root, as the plugin's do, and its storage commands are one per storage
 * method (ADR-0581). Here the Bun store over the same directory
 * (`nodeStore`) answers each, as the plugin answers: its value, or a
 * rejection with the plugin's `StorageError`, `NotFound` for a read of
 * nothing and `Io` for any other failure. `control.refuseNext` fails the next
 * writes before anything lands. A test installs `invoke` with `mock.module`,
 * then opens the folder the way its app does.
 * `packages/tauri-plugin-epicenter-folder` tests the plugin's own checks.
 */
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ClientError, Version } from '@epicenter/definition/contract';
import type { InferError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { nodeStore } from './device/node-store.js';
import type { DeviceExpectation, DeviceStore } from './device/store.js';
import type { StorageError } from './native/bindings.gen.js';

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
 * refused as the plugin refuses it. `opened` lists every open, with its
 * channel.
 */
export function createGrantedShell(
	root: string,
	{ grants = [] }: { grants?: readonly string[] } = {},
) {
	/** Each `open_folder`: the root asked for and its channel. */
	const opened: { root: string; onChange: unknown }[] = [];
	/** Allowed roots the page has opened. */
	const admitted = new Set<string>();
	const calls: ShellCall[] = [];
	const control = {
		/** The shell's answer to `open_folder`; throw to refuse. */
		open: (): unknown => null,
		/** How many upcoming writes fail before anything lands. */
		refuseNext: 0,
	};
	const storage = nodeStore(root);
	const granted = new Map(grants.map((grant) => [grant, nodeStore(grant)]));
	/** The storage of the root a call named, or the plugin's refusal. */
	function storageFor(args: Record<string, unknown>): DeviceStore {
		const named = args.root;
		if (named === root) return storage;
		const found = granted.get(named as string);
		if (found !== undefined && admitted.has(named as string)) return found;
		throw {
			name: 'Io',
			path: (args.path as string | undefined) ?? '',
			operation: 'open',
			message: `NotGranted { root: ${JSON.stringify(named)} }`,
		} satisfies StorageError;
	}

	const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
		async open_folder(args) {
			const named = args.root as string;
			opened.push({ root: named, onChange: args.onChange });
			const answer = control.open();
			// As `scope.rs` refuses a root that is not an absolute path.
			if (!isAbsolute(named))
				throw {
					name: 'Refused',
					root: named,
					reason: `${named} is not a full path to a folder.`,
				};
			// The shell answers the root it watches.
			if (named === root) return answer === null ? root : answer;
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
		root,
		opened,
		calls,
		control,
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
