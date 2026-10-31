/**
 * `@epicenter/folder/tauri`: open a directory the desktop shell lets this
 * window reach, as a contract's typed client (`openDevice`) or as a folder
 * of tables (`openFolder`). The shell answers each storage command, and its
 * watcher sends the paths that changed. A standalone app opens its two roots
 * with `openAppData` and `openDataFolder`.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { Channel, isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { hostStorage } from './boundary.js';
import type { ChangeListener, ChangeSource } from './changes.js';
import { createDeviceClient } from './device/client.js';
import { tauriStore } from './device/tauri-store.js';
import { OpenDeviceError, OpenFolderError } from './errors.js';
import {
	createFolder,
	type Opened,
	type OpenOptions,
	type Tables,
} from './folder.js';
import {
	commands,
	type FolderChanged,
	type WindowError,
} from './native/bindings.gen.js';
import { openRefusal } from './native/open-refusal.js';
import { storageHost } from './storage.js';
import { tauriHostFiles } from './tauri-files.js';

export * from './contract.js';
export {
	chooseFolder,
	defaultDataFolder,
	type FolderRequest,
	type FolderSync,
	openAppData,
	openDataFolder,
} from './desktop-folder.js';
export {
	EpicenterSyncError,
	syncedWithEpicenter,
	syncWithEpicenter,
} from './epicenter-sync.js';
export {
	type FolderSettings,
	rememberFolder,
	type SettingsContract,
} from './settings.js';

/**
 * The typed client of `contract` over a directory the desktop shell lets
 * this window reach, once the shell opened it and started watching it. With
 * no `path`, or a relative one, it is the window's own folder, or a folder
 * inside it (a data folder may sit at any depth). An absolute `path` names
 * a root by its path: the window's own folder, or any folder Tauri's
 * file-system scope allows, which the app's capability does for its default
 * data folder and the folder picker (`chooseFolder`) does for the folder a
 * person picks. `create` makes a missing root (only a default should be
 * made); otherwise a missing one is `Missing`.
 *
 * An `Err` says why nothing opened (`OpenDeviceError`); a contract that is
 * not well formed, or a relative `path` that leaves the folder, throws.
 *
 * ```ts
 * const device = await openDevice(notes, { path: '/Users/me/Notes' });
 * if (device.error !== null) return device;
 * ```
 */
export async function openDevice<TContract extends Contract>(
	contract: TContract,
	{ path, create = false }: { path?: string; create?: boolean } = {},
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	const root = path !== undefined && isAbsolute(path) ? path : undefined;
	if (!isTauri())
		return OpenDeviceError.StorageUnavailable({
			cause: 'openDevice from /tauri runs only in a Tauri window',
		});
	const opened = await openRoot(root ?? null, create);
	if (opened.error !== null)
		return deviceRefusal(opened.error.cause, root ?? "this window's folder");
	const { root: openedRoot, watch } = opened.data;
	const device = createDeviceClient(
		contract,
		tauriStore({
			root: openedRoot,
			inside: root === undefined ? path : undefined,
			watch,
		}),
	);
	if (root !== undefined) roots.set(device, openedRoot);
	return Ok(device);
}

/** The root each client opened by an absolute path, as the shell answered it. */
const roots = new WeakMap<object, string>();

/**
 * The root `device` was opened at by an absolute path, exactly as the shell
 * answered it (its canonical path): what the window's other native commands
 * take to reach the same folder, such as the recorder's `root`. Undefined
 * for a client of the window's own folder, which those commands reach by
 * naming no root.
 */
export function rootOf(device: Client<Contract>): string | undefined {
	return roots.get(device);
}

/** An absolute path on macOS, Linux, or Windows (a drive or a UNC path). */
const isAbsolute = (path: string) =>
	path.startsWith('/') ||
	/^[A-Za-z]:[\\/]/.test(path) ||
	path.startsWith('\\\\');

/** Why the shell opened no root, as `openDevice` says it. */
function deviceRefusal(refusal: unknown, folder: string) {
	// Tauri also rejects with strings for missing commands or permissions;
	// only an object with a name is the shell's own refusal.
	if (typeof refusal !== 'object' || refusal === null || !('name' in refusal))
		return OpenDeviceError.StorageUnavailable({ cause: refusal });
	const error = refusal as WindowError;
	switch (error.name) {
		case 'Missing':
			return OpenDeviceError.Missing({ folder });
		case 'NotGranted':
			return OpenDeviceError.NotGranted({ folder });
		case 'Refused':
			return OpenDeviceError.Refused({ folder, reason: error.reason });
		case 'Unavailable':
			return OpenDeviceError.Unreadable({ folder, cause: error.message });
		case 'NotBound':
		case 'ShuttingDown':
			return OpenDeviceError.StorageUnavailable({ cause: error.name });
		default:
			return OpenDeviceError.StorageUnavailable({
				cause: error satisfies never,
			});
	}
}

/** A root the shell opened: its canonical path, and its watcher's changes. */
type OpenedRoot = { root: string; watch: ChangeSource };

/** Why the shell opened no root: its `WindowError`, or what Tauri rejected with. */
type NotOpened = { cause: unknown };

/**
 * Who hears each root's watcher, by the root's canonical path. The shell
 * sends a root's changes to the last channel opened for it, so every
 * channel opened for a root tells the same listeners, and every handle over
 * the root hears them whichever opened last.
 */
const listeners = new Map<string, Set<ChangeListener>>();

/**
 * Ask the shell to open `root` (the window's own folder for `null`) and watch
 * it: each call asks again, so a folder that came back opens, and one that
 * went is refused.
 */
async function openRoot(
	root: string | null,
	create: boolean,
): Promise<Result<OpenedRoot, NotOpened>> {
	let heard: Set<ChangeListener> | undefined;
	const channel = new Channel<FolderChanged>();
	channel.onmessage = ({ paths }) => {
		for (const listener of heard ?? []) listener(paths);
	};
	let opened: Awaited<ReturnType<typeof commands.openFolder>>;
	try {
		opened = await commands.openFolder(root, create, channel);
	} catch (cause) {
		return Err({ cause });
	}
	if (opened.error !== null) return Err({ cause: opened.error });
	const answered = opened.data;
	const known = listeners.get(answered) ?? new Set<ChangeListener>();
	listeners.set(answered, known);
	heard = known;
	return Ok({
		root: answered,
		watch(listener) {
			known.add(listener);
			return () => known.delete(listener);
		},
	});
}

/**
 * The window's own folder as a folder of tables, watched by the shell. Outside
 * Tauri it is `NotTauri`; a shell refusal is the matching `OpenFolderError`.
 */
export async function openFolder<const T extends Tables>(
	options: OpenOptions<T>,
): Opened<T> {
	if (!isTauri()) return OpenFolderError.NotTauri();
	const opened = await openRoot(null, false);
	if (opened.error !== null) {
		const { cause: error } = opened.error;
		// Tauri also rejects with strings for missing commands or permissions;
		// only an object with a name is the shell's own refusal.
		if (typeof error !== 'object' || error === null || !('name' in error))
			return OpenFolderError.Unavailable({ cause: error });
		return openRefusal(error as WindowError);
	}
	return createFolder(
		storageHost(hostStorage(tauriHostFiles()), { watch: opened.data.watch }),
		options,
	);
}
