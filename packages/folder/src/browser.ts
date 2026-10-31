/**
 * `@epicenter/folder/browser`: two openers for this web origin.
 *
 * - `openDevice(contract)`: a contract's typed client over the origin's
 *   private file system (OPFS), at the same paths a desktop folder holds:
 *   an app's local web variant, which keeps its files in this browser for
 *   good and never uploads them (ADR-0700).
 * - `openFolder({ tables })`: the legacy default local folder, kept in
 *   IndexedDB as a Git working tree. A blob's oid is its change stamp, and
 *   other tabs' saves arrive as hints.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { isTauri } from '@tauri-apps/api/core';
import { Ok, type Result } from 'wellcrafted/result';
import { openRepository } from './browser/repository.js';
import { snapshotContent } from './browser/storage.js';
import { createDeviceClient, storeOf } from './device/client.js';
import { DeviceError, opfsStore } from './device/opfs-store.js';
import { OpenDeviceError, OpenFolderError } from './errors.js';
import {
	createFolder,
	type Opened,
	type OpenOptions,
	type Tables,
} from './folder.js';
import { ReadError } from './shared/errors.js';
import type { Fetched, FolderHost } from './storage.js';

export * from './contract.js';
export { DeviceError } from './device/opfs-store.js';

/**
 * The typed client of `contract` over this origin's private file system, or
 * `StorageUnavailable` in a context with no Worker to own the files. The
 * Worker starts at the first call. A browser that gives the page no private
 * storage (WebKit's ephemeral contexts, Safari's private windows) still
 * opens: each call is then `Unavailable`, its cause a
 * `DeviceError.StorageRefused`, so an app keeps working in memory (a local
 * app keeps a recording in the page to save again or download). A contract
 * that is not well formed throws.
 *
 * @example
 * ```ts
 * const device = await openDevice(recorder);
 * if (device.error !== null) return device;
 * const note = await device.data.recordings.create({ id: timeId(), title: 'Standup' });
 * ```
 *
 * `closeDevice(device)` stops its Worker (on hot reload, or at the end of a
 * test).
 */
export async function openDevice<TContract extends Contract>(
	contract: TContract,
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	if (typeof Worker === 'undefined')
		return OpenDeviceError.StorageUnavailable({
			cause: DeviceError.WorkerFailed({ cause: 'this context has no Worker' })
				.error,
		});
	return Ok(createDeviceClient(contract, opfsStore()));
}

/**
 * Stop the Worker of a client `openDevice` returned; every later call is
 * `Unavailable`. Its files stay.
 */
export function closeDevice(device: Client<Contract>): void {
	storeOf(device).close?.();
}

/** The same fixed key as the browser's default folder, so its files carry over. */
const DEFAULT_KEY = 'default';

export async function openFolder<const T extends Tables>(
	options: OpenOptions<T>,
): Opened<T> {
	// The desktop app opens its window's directory through the Tauri entry.
	if (isTauri()) return OpenFolderError.InsideTauri();
	if (typeof indexedDB === 'undefined')
		return OpenFolderError.Unavailable({
			cause: new Error('IndexedDB is not available in this page'),
		});
	let repository: Awaited<ReturnType<typeof openRepository>>;
	try {
		repository = await openRepository(DEFAULT_KEY);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	return createFolder(repositoryHost(repository), options);
}

function repositoryHost(
	repository: Awaited<ReturnType<typeof openRepository>>,
): FolderHost {
	const { storage } = repository;
	return {
		async list() {
			try {
				// An empty scope walks every tree and loads no blob.
				const snapshot = await storage.capture([]);
				const listed = new Map<string, { stamp: string }>();
				for (const [path, entry] of snapshot.files)
					if (entry.mode !== '160000') listed.set(path, { stamp: entry.oid });
				return Ok(listed);
			} catch (cause) {
				return ReadError.StorageFailed({ cause });
			}
		},
		async read(paths) {
			try {
				const snapshot = await storage.capture(paths);
				return new Map<string, Result<Fetched, ReadError>>(
					paths.map((path) => {
						const entry = snapshot.files.get(path);
						if (snapshot.directories.has(path))
							return [
								path,
								ReadError.StorageFailed({ cause: `${path} is a directory` }),
							] as const;
						const bytes = snapshotContent(snapshot, path);
						const fetched: Fetched =
							entry === undefined || bytes === null
								? null
								: {
										bytes: bytes.slice(),
										stamp: entry.oid,
									};
						return [path, Ok(fetched)];
					}),
				);
			} catch (cause) {
				const failed = ReadError.StorageFailed({ cause });
				return new Map(paths.map((path) => [path, failed]));
			}
		},
		async put(path, bytes, expect) {
			const { data, error } = await repository.put(path, bytes, expect);
			if (error !== null) return { data: null, error };
			const { landed } = data;
			return Ok(landed === null ? null : { stamp: landed.version });
		},
		hints: (listener) =>
			repository.onChange(({ paths, origin }) => {
				if (origin === 'other-handle') listener(paths);
			}),
		close: repository.close,
	};
}
