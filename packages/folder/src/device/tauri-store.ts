/**
 * A device store in a Tauri window: a root the page opened (`root`, by name:
 * `Data` or `AppData`), named in every call. Each method is one command of
 * the folder plugin (ADR-0581), which the shell answers over that root and
 * refuses for a root the page did not open. The shell checks
 * every path itself (`storage.rs`: literal names, no link followed, `.git`
 * never named, a nonportable name never made), stages each write, and renames
 * it over its path after checking the version it expects right before the
 * rename. Changes come from the shell's watcher of that directory (`watch`).
 *
 * The raw commands carry bytes the generated bindings cannot type: a read
 * answers the stamp and the bytes as one `ArrayBuffer`, split at the first
 * NUL, and a write sends its bytes as the request body, with the path and
 * its expectation in headers (`absent`, or `sha256:` and the hash, so a hash
 * and the keyword never share one spelling).
 *
 * Whatever the shell refuses, or a call that never reached it, is
 * `Unavailable`. Tauri 2 sends a call again when its custom-protocol request
 * fails, so a write whose first run landed may answer `stale`; the client
 * then reads again and finds its own bytes.
 */

import { ClientError, type Version } from '@epicenter/definition/contract';
import { invoke } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import { type ChangeSource, createChanges } from '../changes.js';
import { hashBytes } from '../hash.js';
import {
	commands,
	type PutOutcome,
	type Root,
} from '../native/bindings.gen.js';
import type { DeviceStore } from './store.js';

/**
 * The store of the root named `root`, hearing changes from `watch` (the
 * shell's watcher, whose paths are relative to the root). Whenever the shell refuses, a call
 * is `Unavailable`. Only `openDevice`, once it found a Tauri window, makes
 * one.
 */
export function tauriStore({
	root,
	watch,
}: {
	root: Root;
	watch: ChangeSource;
}): DeviceStore {
	const changes = createChanges(watch);
	const unavailable = (cause: unknown) => ClientError.Unavailable({ cause });

	return {
		async list() {
			let listed: Awaited<ReturnType<typeof commands.listFolder>>;
			try {
				listed = await commands.listFolder(root);
			} catch (cause) {
				return unavailable(cause);
			}
			if (listed.error !== null) return unavailable(listed.error);
			return Ok(listed.data);
		},
		async read(path) {
			let response: Uint8Array;
			try {
				response = new Uint8Array(
					await invoke<ArrayBuffer>(
						'plugin:epicenter-folder|read_folder_file',
						{ path, root },
					),
				);
			} catch (cause) {
				if (isNotFound(cause)) return Ok(null);
				return unavailable(cause);
			}
			const separator = response.indexOf(0);
			if (separator < 0)
				return unavailable(new Error('The file response has no stamp'));
			const stamp = new TextDecoder().decode(response.subarray(0, separator));
			const bytes = response.subarray(separator + 1);
			return Ok({ bytes, version: (await hashBytes(bytes)) as Version, stamp });
		},
		async write(path, bytes, expected) {
			const headers: Record<string, string> = {
				path: encodeURIComponent(path),
				root: encodeURIComponent(root),
				remove: String(bytes === null),
				expected:
					typeof expected === 'string' ? expected : `sha256:${expected.sha256}`,
			};
			try {
				const outcome = await invoke<PutOutcome>(
					'plugin:epicenter-folder|put_folder_file',
					bytes === null ? new Uint8Array() : new Uint8Array(bytes),
					{ headers },
				);
				return Ok(outcome);
			} catch (cause) {
				return unavailable(cause);
			}
		},
		watch: changes.watch,
	};
}

/** Whether the shell answered that no file is at the path. */
const isNotFound = (value: unknown) =>
	typeof value === 'object' &&
	value !== null &&
	'name' in value &&
	value.name === 'NotFound';
