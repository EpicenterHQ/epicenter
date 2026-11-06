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
 * A version is the file's Git blob id (ADR-0808). The shell names a note,
 * and any hidden file, by the blob id of its bytes, and an attachment by its
 * stamp, which this store turns into the blob id of its Git LFS pointer
 * through the stamp cache (`stamp-cache.ts`), hashing an attachment it has
 * not cached once. The raw commands carry bytes the generated bindings
 * cannot type: a read answers the stamp and the bytes as one `ArrayBuffer`,
 * split at the first NUL, and a write sends its bytes as the request body,
 * with the path and its expectation in headers (`absent`, `blob:` and a
 * note's blob id, or `stamp:` and an attachment's stamp, read and hashed
 * again right before it is replaced), and answers `stale` or the stamp that
 * landed.
 *
 * Whatever the shell refuses, or a call that never reached it, is
 * `Unavailable`. Tauri 2 sends a call again when its custom-protocol request
 * fails, so a write whose first run landed may answer `stale`; the folder
 * then reads again and finds its own bytes.
 */

import { ClientError, storedWithLfs } from '@epicenter/definition/contract';
import { invoke } from '@tauri-apps/api/core';
import { Ok, type Result } from 'wellcrafted/result';
import { blobIdOf, sha256Of } from '../hash.js';
import { commands, type Landing, type Root } from '../native/bindings.gen.js';
import { createStampCache, HASHES_PATH } from './stamp-cache.js';
import {
	type BlobId,
	type Changed,
	type FileRead,
	type Store,
	StoreError,
	type Unavailable,
} from './store.js';

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
}: {
	root: Root;
	listen: (changed: Changed) => () => void;
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
		return { path, bytes, version: await blobIdOf(path, bytes), stamp };
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
					root: encodeURIComponent(root),
					remove: String(bytes === null),
					expected: encodeURIComponent(expected),
				},
			},
		);
	}

	const hashes = createStampCache({
		file: {
			async load() {
				const file = await readOne(HASHES_PATH);
				return 'gone' in file ? null : file.bytes;
			},
			async save(bytes) {
				await send(HASHES_PATH, bytes, 'any');
			},
		},
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
					if (!storedWithLfs(path)) {
						files.push({ path, version: version as BlobId, size });
						continue;
					}
					// An attachment comes with its stamp: its version is cached by it.
					const stamped = { stamp: version, modifiedMs: modifiedMsOf(version) };
					const hashed = await hashes.version(path, stamped, async () => {
						const file = await readOne(path);
						if ('gone' in file)
							throw new Error(`${path} went away while it was listed`);
						return {
							oid: await sha256Of(file.bytes),
							size: file.bytes.byteLength,
						};
					});
					files.push({ path, version: hashed, size });
				}
				if (under.includes(''))
					await hashes.keepOnly(new Set(files.map(({ path }) => path)));
				await hashes.flush();
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
		): Promise<Result<BlobId | null, StoreError | Unavailable>> {
			try {
				let expected = expect === null ? 'absent' : `blob:${expect}`;
				if (expect !== null && storedWithLfs(path)) {
					// An attachment is hashed again before a write replaces it, and
					// the shell checks its stamp did not change since.
					const there = await readOne(path);
					if ('gone' in there || there.version !== expect)
						return StoreError.Moved({
							path,
							now: 'gone' in there ? null : there.version,
						});
					expected = `stamp:${there.stamp}`;
				}
				const landing = await send(path, bytes, expected);
				if (landing === 'stale') return moved(path);
				return Ok(bytes === null ? null : await blobIdOf(path, bytes));
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
