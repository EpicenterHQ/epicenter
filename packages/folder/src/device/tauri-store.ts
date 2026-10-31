/**
 * A device store in a Tauri window: the directory the desktop shell bound
 * to the window, through the folder plugin's storage commands. The page
 * never names a directory (the plugin takes its root from the window), so
 * the store's root is that directory, or a folder `inside` it. The shell
 * stages each write and renames it over its path, checking the version it
 * expects under the directory's save lock, the lock Bun takes too. Changes
 * come from the shell's watcher of that directory (`watch`).
 */

import { ClientError, type Version } from '@epicenter/definition/contract';
import { isTauri } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import { hostStorage } from '../boundary.js';
import { type ChangeSource, createChanges } from '../changes.js';
import { pathProblem } from '../paths.js';
import { tauriHostFiles } from '../tauri-files.js';
import type { DeviceStore } from './store.js';

/**
 * The store of the bound directory, or of the folder at the relative path
 * `inside` it, hearing changes from `watch` (the shell's watcher, whose
 * paths are relative to the bound directory). A path that is not plainly
 * relative throws here, at once; outside Tauri, and whenever the shell
 * refuses, a call is `Unavailable`.
 */
export function tauriStore({
	inside,
	watch,
}: {
	inside?: string;
	watch: ChangeSource;
}): DeviceStore {
	if (inside !== undefined) {
		const problem = pathProblem(inside);
		if (problem !== undefined)
			throw new Error(`openDevice: '${inside}' cannot be opened: ${problem}`);
	}
	const prefix = inside === undefined ? '' : `${inside}/`;
	const files = hostStorage(tauriHostFiles());
	const changes = createChanges((emit) =>
		watch((paths) => {
			if (paths === null) return emit(null);
			const inner = paths
				.filter((path) => path.startsWith(prefix))
				.map((path) => path.slice(prefix.length));
			if (inner.length > 0) emit(inner);
		}),
	);
	const notTauri = () =>
		ClientError.Unavailable({
			cause: new Error('openDevice from /tauri runs only in a Tauri window'),
		});

	return {
		async list() {
			if (!isTauri()) return notTauri();
			const listed = await files.list();
			if (listed.error !== null)
				return ClientError.Unavailable({ cause: listed.error });
			return Ok(
				listed.data.files
					.filter(({ path }) => path.startsWith(prefix))
					.map(({ path, stamp }) => ({
						path: path.slice(prefix.length),
						stamp,
					})),
			);
		},
		async read(path) {
			if (!isTauri()) return notTauri();
			const read = await files.read(prefix + path);
			if (read.error?.name === 'NotFound') return Ok(null);
			if (read.error !== null)
				return ClientError.Unavailable({ cause: read.error });
			const { bytes, sha256, stamp } = read.data;
			return Ok({ bytes, version: sha256 as Version, stamp });
		},
		async write(path, bytes, expected) {
			if (!isTauri()) return notTauri();
			const put = await files.put(
				prefix + path,
				bytes,
				expected === 'absent' ? 'absent' : { sha256: expected },
			);
			if (put.error !== null)
				return ClientError.Unavailable({ cause: put.error });
			return Ok(put.data.kind);
		},
		watch: changes.watch,
	};
}
