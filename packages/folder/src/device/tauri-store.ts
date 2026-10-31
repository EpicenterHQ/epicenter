/**
 * A device store in a Tauri window: a root the window opened (`root`, by the
 * exact path the shell answered), or a folder `inside` it. Each method is one
 * command of the folder plugin (ADR-0581), which the shell answers over that
 * root and refuses for a root the window did not open. The shell checks
 * every path itself (`storage.rs`: literal names, no link followed, `.git`
 * never named, a nonportable name never made), stages each write, and renames
 * it over its path after checking the version it expects right before the
 * rename. Changes come from the shell's watcher of that directory (`watch`).
 *
 * The raw commands carry bytes the generated bindings cannot type: a read
 * answers the stamp and the bytes as one `ArrayBuffer`, split at the first
 * NUL, and a write sends its bytes as the request body, with the path and
 * its expectation in headers (`any`, `absent`, or `sha256:` and the hash, so
 * a hash and a keyword never share one spelling).
 *
 * Whatever the shell refuses, or a call that never reached it, is
 * `Unavailable`. Tauri 2 sends a call again when its custom-protocol request
 * fails, so a write whose first run landed may answer `stale`; the client
 * then reads again and finds its own bytes.
 */

import { ClientError, type Version } from '@epicenter/definition/contract';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import { type ChangeSource, createChanges } from '../changes.js';
import { hashBytes } from '../hash.js';
import { commands, type PutOutcome } from '../native/bindings.gen.js';
import { pathProblem } from '../paths.js';
import type { DeviceStore } from './store.js';

/**
 * The store of the root, or of the folder at the relative path `inside` it,
 * hearing changes from `watch` (the shell's watcher, whose paths are
 * relative to the root). A path that is not plainly relative throws here, at
 * once; outside Tauri, and whenever the shell refuses, a call is
 * `Unavailable`.
 */
export function tauriStore({
	root,
	inside,
	watch,
}: {
	root?: string;
	inside?: string;
	watch: ChangeSource;
}): DeviceStore {
	if (inside !== undefined) {
		const problem = pathProblem(inside);
		if (problem !== undefined)
			throw new Error(`openDevice: '${inside}' cannot be opened: ${problem}`);
	}
	const named = root ?? null;
	const prefix = inside === undefined ? '' : `${inside}/`;
	const changes = createChanges((emit) =>
		watch((paths) => {
			if (paths === null) return emit(null);
			const inner = paths
				.filter((path) => path.startsWith(prefix))
				.map((path) => path.slice(prefix.length));
			if (inner.length > 0) emit(inner);
		}),
	);
	const unavailable = (cause: unknown) => ClientError.Unavailable({ cause });
	const notTauri = () =>
		unavailable(
			new Error('openDevice from /tauri runs only in a Tauri window'),
		);

	return {
		async list() {
			if (!isTauri()) return notTauri();
			let listed: Awaited<ReturnType<typeof commands.listFolder>>;
			try {
				listed = await commands.listFolder(named);
			} catch (cause) {
				return unavailable(cause);
			}
			if (listed.error !== null) return unavailable(listed.error);
			return Ok(
				listed.data
					.filter(({ path }) => path.startsWith(prefix))
					.map(({ path, stamp }) => ({
						path: path.slice(prefix.length),
						stamp,
					})),
			);
		},
		async read(path) {
			if (!isTauri()) return notTauri();
			let response: Uint8Array;
			try {
				response = new Uint8Array(
					await invoke<ArrayBuffer>(
						'plugin:epicenter-folder|read_folder_file',
						{ path: prefix + path, root: named },
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
			if (!isTauri()) return notTauri();
			const headers: Record<string, string> = {
				path: encodeURIComponent(prefix + path),
				remove: String(bytes === null),
				expected:
					typeof expected === 'string' ? expected : `sha256:${expected.sha256}`,
			};
			if (root !== undefined) headers.root = encodeURIComponent(root);
			try {
				const outcome = await invoke<PutOutcome>(
					'plugin:epicenter-folder|put_folder_file',
					bytes === null ? new Uint8Array() : new Uint8Array(bytes),
					{ headers },
				);
				return Ok(outcome.kind);
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
