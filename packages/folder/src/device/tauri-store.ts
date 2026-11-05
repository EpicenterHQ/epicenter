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
 * A version is a note's sha256 and an attachment's stamp, as the shell
 * names them (`versionedByContent`). The raw commands carry bytes the
 * generated bindings cannot type: a read answers the stamp and the bytes as
 * one `ArrayBuffer`, split at the first NUL, and a write sends its bytes as
 * the request body, with the path and its expectation in headers (`absent`,
 * `sha256:` and a note's hash, or `stamp:` and an attachment's stamp), and
 * answers `stale` or the stamp that landed.
 *
 * Whatever the shell refuses, or a call that never reached it, is
 * `Unavailable`. Tauri 2 sends a call again when its custom-protocol request
 * fails, so a write whose first run landed may answer `stale`; the folder
 * then reads again and finds its own bytes.
 */

import { ClientError } from '@epicenter/definition/contract';
import { invoke } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import { hashBytes } from '../hash.js';
import { commands, type Landing, type Root } from '../native/bindings.gen.js';
import {
	type Changed,
	type FileRead,
	type Store,
	type Version,
	versionedByContent,
} from './store.js';

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

	/** The file at `path`: its bytes and version, or gone. */
	async function readOne(path: string): Promise<FileRead> {
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
		const version = versionedByContent(path)
			? ((await hashBytes(bytes)) as Version)
			: (stamp as Version);
		return { path, bytes, version };
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
			return Ok(
				listed.data.map(({ path, version, size }) => ({
					path,
					version: version as Version,
					size,
				})),
			);
		},
		async read(paths) {
			try {
				return Ok(await Promise.all(paths.map(readOne)));
			} catch (cause) {
				return unavailable(cause);
			}
		},
		async write(path, bytes, over) {
			const headers: Record<string, string> = {
				path: encodeURIComponent(path),
				root: encodeURIComponent(root),
				remove: String(bytes === null),
				expected:
					over === 'absent'
						? over
						: versionedByContent(path)
							? `sha256:${over}`
							: `stamp:${encodeURIComponent(over)}`,
			};
			try {
				const landing = await invoke<Landing>(
					'plugin:epicenter-folder|put_folder_file',
					bytes === null ? new Uint8Array() : new Uint8Array(bytes),
					{ headers },
				);
				if (landing === 'stale') return Ok('stale');
				if (bytes === null) return Ok(null);
				return Ok(
					versionedByContent(path)
						? ((await hashBytes(bytes)) as Version)
						: (landing.landed as Version),
				);
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
