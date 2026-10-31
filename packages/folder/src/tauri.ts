/**
 * `@epicenter/folder/tauri`: open the directory the desktop shell bound
 * to this window, as a contract's typed client (`openDevice`) or as a
 * folder of tables (`openFolder`). The shell answers each storage command,
 * and its watcher sends the paths that changed.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { Channel, isTauri } from '@tauri-apps/api/core';
import { hostStorage } from './boundary.js';
import { createDeviceClient } from './device/client.js';
import { tauriStore } from './device/tauri-store.js';
import { OpenFolderError } from './errors.js';
import {
	createFolder,
	type Opened,
	type OpenOptions,
	type Tables,
} from './folder.js';
import { commands, type FolderChanged } from './native/bindings.gen.js';
import { openRefusal } from './native/open-refusal.js';
import { storageHost } from './storage.js';
import { tauriHostFiles } from './tauri-files.js';

export { type AppConfig, appConfig } from './app-config.js';
export * from './contract.js';
export {
	EpicenterSyncError,
	syncedWithEpicenter,
	syncWithEpicenter,
} from './epicenter-sync.js';

/**
 * The typed client of `contract` over the directory the desktop shell bound
 * to this window: for a bundled or standalone app, its local data folder.
 * A page names no directory; `path`, when given, is a relative folder
 * inside the bound one (a data folder may sit at any depth). Outside Tauri,
 * or when the shell refuses, each call is `Unavailable`, never a throw; a
 * contract that is not well formed, or a `path` that leaves the bound
 * directory, throws here, at once.
 *
 * ```ts
 * const device = openDevice(recorder);
 * const note = await device.recordings.create({ id: timeId(), title: 'Standup' });
 * ```
 */
export function openDevice<TContract extends Contract>(
	contract: TContract,
	{ path }: { path?: string } = {},
): Client<TContract> {
	return createDeviceClient(
		contract,
		tauriStore({ inside: path, watch: watchBoundFolder }),
	);
}

/**
 * Hear the shell's watcher of the bound directory: the same registration
 * every `openFolder` handle shares, held while anything listens. Outside
 * Tauri, or when the shell refuses, nothing is heard.
 */
function watchBoundFolder(listener: (paths: readonly string[] | null) => void) {
	if (!isTauri()) return () => {};
	const observer = ({ paths }: FolderChanged) => listener(paths);
	observers.add(observer);
	openHandles++;
	openBoundFolder().catch(() => {});
	return () => {
		observers.delete(observer);
		openHandles--;
		releaseRegistrationIfIdle();
	};
}

const observers = new Set<(change: FolderChanged) => void>();
let opening: ReturnType<typeof commands.openFolder> | undefined;
let openHandles = 0;
let pendingOpens = 0;

function releaseRegistrationIfIdle() {
	if (openHandles === 0 && pendingOpens === 0) opening = undefined;
}

function openBoundFolder() {
	if (opening) return opening;
	const channel = new Channel<FolderChanged>();
	channel.onmessage = (change) => {
		for (const observer of observers) observer(change);
	};
	opening = commands.openFolder(channel).then(
		(opened) => {
			if (opened.error !== null) opening = undefined;
			return opened;
		},
		(cause) => {
			opening = undefined;
			throw cause;
		},
	);
	return opening;
}

export async function openFolder<const T extends Tables>(
	options: OpenOptions<T>,
): Opened<T> {
	if (!isTauri()) return OpenFolderError.NotTauri();
	let opened: Awaited<ReturnType<typeof commands.openFolder>>;
	const listeners = new Set<(paths: readonly string[] | null) => void>();
	const observer = ({ paths }: FolderChanged) => {
		for (const listener of listeners) listener(paths);
	};
	observers.add(observer);
	let retained = false;
	const stop = () => {
		observers.delete(observer);
		if (retained) {
			retained = false;
			openHandles--;
			releaseRegistrationIfIdle();
		}
	};
	pendingOpens++;
	try {
		opened = await openBoundFolder();
	} catch (cause) {
		pendingOpens--;
		stop();
		releaseRegistrationIfIdle();
		return OpenFolderError.Unavailable({ cause });
	}
	pendingOpens--;
	if (opened.error !== null) {
		stop();
		releaseRegistrationIfIdle();
		const { error } = opened;
		// Tauri also rejects with strings for missing commands or permissions;
		// only an object with a name is the shell's own refusal.
		if (typeof error !== 'object' || error === null || !('name' in error))
			return OpenFolderError.Unavailable({ cause: error });
		return openRefusal(error);
	}
	try {
		retained = true;
		openHandles++;
		const result = await createFolder(
			storageHost(hostStorage(tauriHostFiles()), {
				watch(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
						stop();
					};
				},
			}),
			options,
		);
		if (result.error !== null) stop();
		return result;
	} catch (cause) {
		stop();
		throw cause;
	}
}
