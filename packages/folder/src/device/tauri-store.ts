/**
 * A device store in a Tauri window: a root the page opened (`root`, by name:
 * `Data` or `AppData`), named in every call. Each method is one command of
 * the folder plugin (ADR-0581), which the shell answers over that root and
 * refuses for a root the page did not open. The shell checks every path
 * itself (`storage.rs`: literal names, no link followed, `.git` never
 * named, a nonportable name never made), stages each write, and renames it
 * over its path after checking the version it expects right before the
 * rename. Changes come from the shell's watcher of that directory, which
 * listens from the moment the root opened (`watch`).
 *
 * A version is the SHA-256 of the file's bytes (ADR-0824). The shell's
 * listing says which it gives for each file: `sha256:` and the version of a
 * small file it hashed, or `stamp:` and the stamp of a large one, which
 * this store turns into its version through the stamp cache
 * (`stamp-cache.ts`), hashing a file it has not cached once. The cache is kept where the caller says (`hashes`),
 * outside the folder (ADR-0822): an app's in its own data, the Epicenter
 * app's in the Epicenter folder's `.epicenter`. The raw commands carry bytes the generated bindings
 * cannot type: a read answers the stamp and the bytes as one `ArrayBuffer`,
 * split at the first NUL, and a write sends its bytes as the request body,
 * with the path and its expectation in headers (`absent`, or `sha256:` and
 * the version the shell hashes again right before it replaces the file),
 * and answers `stale` or the stamp that landed.
 *
 * Whatever the shell refuses, or a call that never reached it, is
 * `Unavailable`. Tauri 2 sends a call again when its custom-protocol request
 * fails, so a write whose first run landed may answer `stale`; the folder
 * then reads again and finds its own bytes.
 */

import { ClientError } from '@epicenter/definition/contract';
import { invoke } from '@tauri-apps/api/core';
import { Ok, type Result } from 'wellcrafted/result';
import { versionOf } from '../hash.js';
import { commands, type Landing, type Root } from '../native/bindings.gen.js';
import { createStampCache, type StampFile } from './stamp-cache.js';
import {
	type Changed,
	type FileRead,
	type Store,
	StoreError,
	type Unavailable,
	type Version,
} from './store.js';

/**
 * A root as a raw request's `root` header spells it: `Data`, `AppData`,
 * `Epicenter`, or `Folder/<name>` for a folder in the Epicenter folder
 * (`Root::header` in the plugin).
 */
export const rootHeader = (root: Root) =>
	typeof root === 'string' ? root : `Folder/${root.Folder}`;

/** Whether `a` and `b` name one root. */
export const sameRoot = (a: Root, b: Root) => rootHeader(a) === rootHeader(b);

/** The modification time in a shell stamp (`v1:<size>:<nanoseconds>[:<device>:<inode>]`), in milliseconds. */
const modifiedMsOf = (stamp: string) =>
	Number(BigInt(stamp.split(':')[2] ?? '0') / 1_000_000n);

/**
 * The store of the root named `root`, hearing changes from `listen` (the
 * shell's watcher, whose paths are relative to the root, already listening
 * once the root opened). Whenever the shell refuses, a call is
 * `Unavailable`. Only `openRoot`, once it found a Tauri window, makes one.
 */
export function tauriStore({
	root,
	listen,
	hashes = null,
}: {
	root: Root;
	listen: (changed: Changed) => () => void;
	/** Where its attachments' hashes are kept between runs; without one, for the store's life only. */
	hashes?: StampFile | null;
}): Store {
	const unavailable = (cause: unknown) => ClientError.Unavailable({ cause });

	/** The file at `path`: its bytes, its stamp, and its version, or gone. */
	async function readOne(path: string): Promise<FileRead & { stamp?: string }> {
		let response: Uint8Array;
		try {
			response = new Uint8Array(
				await invoke<ArrayBuffer>('plugin:epicenter-folder|read_folder_file', {
					path,
					root,
				}),
			);
		} catch (cause) {
			if (isNotFound(cause)) return { path, gone: true };
			throw cause;
		}
		const separator = response.indexOf(0);
		if (separator < 0) throw new Error('The file response has no stamp');
		const stamp = new TextDecoder().decode(response.subarray(0, separator));
		const bytes = response.subarray(separator + 1);
		return { path, bytes, version: await versionOf(bytes), stamp };
	}

	/** Put `bytes` (null: remove) at `path` as the shell expects `expected`: the shell's answer. */
	async function send(
		path: string,
		bytes: Uint8Array | null,
		expected: string,
	): Promise<Landing> {
		return invoke<Landing>(
			'plugin:epicenter-folder|put_folder_file',
			bytes === null ? new Uint8Array() : new Uint8Array(bytes),
			{
				headers: {
					path: encodeURIComponent(path),
					root: encodeURIComponent(rootHeader(root)),
					remove: String(bytes === null),
					expected: encodeURIComponent(expected),
				},
			},
		);
	}

	const cache = createStampCache({
		file: hashes ?? { load: async () => null, save: async () => {} },
	});

	/** What the path holds now, as `Moved`. */
	async function moved(path: string) {
		const now = await readOne(path);
		return StoreError.Moved({
			path,
			now: 'gone' in now ? null : now.version,
		});
	}

	return {
		async list(under) {
			let listed: Awaited<ReturnType<typeof commands.listFolder>>;
			try {
				listed = await commands.listFolder(root, [...under]);
			} catch (cause) {
				return unavailable(cause);
			}
			if (listed.error !== null) return unavailable(listed.error);
			try {
				const files = [];
				for (const { path, version, size } of listed.data) {
					const hashed = version.startsWith('sha256:')
						? (version.slice('sha256:'.length) as Version)
						: undefined;
					if (hashed !== undefined) {
						files.push({ path, version: hashed, size });
						continue;
					}
					if (!version.startsWith('stamp:'))
						throw new Error(
							`${path} is listed by an unknown version, ${version}`,
						);
					// A large file comes with its stamp: its version is cached by it.
					const stamp = version.slice('stamp:'.length);
					const stamped = { stamp, modifiedMs: modifiedMsOf(stamp) };
					const cached = await cache.version(path, stamped, async () => {
						const file = await readOne(path);
						if ('gone' in file)
							throw new Error(`${path} went away while it was listed`);
						return file.version;
					});
					files.push({ path, version: cached, size });
				}
				if (under.includes(''))
					await cache.keepOnly(new Set(files.map(({ path }) => path)));
				await cache.flush();
				return Ok(files);
			} catch (cause) {
				return unavailable(cause);
			}
		},
		async read(paths) {
			try {
				const files = await Promise.all(paths.map(readOne));
				return Ok(files.map(({ stamp: _, ...file }) => file as FileRead));
			} catch (cause) {
				return unavailable(cause);
			}
		},
		async put(
			path,
			bytes,
			expect,
		): Promise<Result<Version | null, StoreError | Unavailable>> {
			try {
				// The shell hashes the file there again right before it replaces it.
				const expected = expect === null ? 'absent' : `sha256:${expect}`;
				const landing = await send(path, bytes, expected);
				if (landing === 'stale') return moved(path);
				return Ok(bytes === null ? null : await versionOf(bytes));
			} catch (cause) {
				return unavailable(cause);
			}
		},
		async watch(changed) {
			return Ok(listen(changed));
		},
		close() {},
	};
}

/** Whether the shell answered that no file is at the path. */
const isNotFound = (value: unknown) =>
	typeof value === 'object' &&
	value !== null &&
	'name' in value &&
	value.name === 'NotFound';
