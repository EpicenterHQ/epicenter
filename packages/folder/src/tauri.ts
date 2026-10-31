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

export {
	type AppConfig,
	type AppFolders,
	appConfig,
	appFolders,
	rememberFolder,
} from './app-config.js';
export * from './contract.js';
export {
	EpicenterSyncError,
	syncedWithEpicenter,
	syncWithEpicenter,
} from './epicenter-sync.js';

/**
 * The typed client of `contract` over a directory the desktop shell gave this
 * window. With no `path`, or a relative one, it is the window's own folder,
 * or a folder inside it (a data folder may sit at any depth). An absolute
 * `path` names a root by its exact path: the window's own folder, or another
 * root the shell granted the window, such as the app's configuration
 * directory (decision 82). The shell refuses any other root, so a page
 * reaches only what its app's Rust allowed. Only the window's own folder is
 * watched; a granted root hears no changes made elsewhere.
 *
 * Outside Tauri, or when the shell refuses, each call is `Unavailable`,
 * never a throw; a contract that is not well formed, or a relative `path`
 * that leaves the folder, throws here, at once.
 *
 * ```ts
 * const config = openDevice(appConfig, { path: configDirectory });
 * const device = openDevice(capture, { path: folder });
 * ```
 */
export function openDevice<TContract extends Contract>(
	contract: TContract,
	{ path }: { path?: string } = {},
): Client<TContract> {
	const root = path !== undefined && isAbsolute(path) ? path : undefined;
	return createDeviceClient(
		contract,
		tauriStore({
			root,
			inside: root === undefined ? path : undefined,
			watch: (listener) => watchBoundFolder(listener, root),
		}),
	);
}

/** An absolute path on macOS, Linux, or Windows (a drive or a UNC path). */
const isAbsolute = (path: string) =>
	path.startsWith('/') ||
	/^[A-Za-z]:[\\/]/.test(path) ||
	path.startsWith('\\\\');

/**
 * Hear the shell's watcher of the window's own folder: the same registration
 * every handle shares, held while anything listens. A device opened at an
 * absolute `root` hears it only once the shell answered that `root` is the
 * watched folder; a granted root is not watched. Outside Tauri, or when the
 * shell refuses, nothing is heard.
 */
function watchBoundFolder(
	listener: (paths: readonly string[] | null) => void,
	root?: string,
) {
	if (!isTauri()) return () => {};
	let hears = root === undefined;
	const observer = ({ paths }: FolderChanged) => {
		if (hears) listener(paths);
	};
	observers.add(observer);
	openHandles++;
	openBoundFolder().then(
		(opened) => {
			if (root !== undefined && opened.error === null && opened.data === root)
				hears = true;
		},
		() => {},
	);
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
