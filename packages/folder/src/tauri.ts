/**
 * `@epicenter/folder/tauri`: open a directory the desktop shell lets this
 * window reach as a contract's typed client (`openDevice`). The shell
 * answers each storage command, and its watcher sends the paths that
 * changed. A standalone app opens its two roots with `openAppData` and
 * `openDataFolder`.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { Channel, isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ChangeListener, ChangeSource } from './changes.js';
import { createDeviceClient } from './device/client.js';
import { tauriStore } from './device/tauri-store.js';
import { OpenDeviceError } from './errors.js';
import { commands, type FolderChanged } from './native/bindings.gen.js';
import { deviceRefusal } from './native/open-refusal.js';

export {
	type FolderRequest,
	openAppData,
	openDataFolder,
} from './desktop-folder.js';
export { syncedWithEpicenter, syncWithEpicenter } from './epicenter-sync.js';
export { OpenDeviceError } from './errors.js';

/**
 * The typed client of `contract` over the root at the absolute path `path`,
 * once the desktop shell opened it and started watching it: the directory
 * the shell bound to the window before it existed (its AppData root), or
 * any folder Tauri's runtime file-system scope allows, which the
 * standalone shell does for the app's default data folder at startup and the
 * folder picker does for other folders.
 * `create` makes a missing root (only a default should be made); otherwise a
 * missing one is `Missing`. A relative `path` names no root: the shell
 * refuses it (`Refused`).
 *
 * An `Err` says why nothing opened (`OpenDeviceError`); a contract that is
 * not well formed throws.
 *
 * ```ts
 * const device = await openDevice(notes, { path: '/Users/me/Notes' });
 * if (device.error !== null) return device;
 * ```
 */
export async function openDevice<TContract extends Contract>(
	contract: TContract,
	{ path, create = false }: { path: string; create?: boolean },
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	if (!isTauri())
		return OpenDeviceError.StorageUnavailable({
			cause: 'openDevice from /tauri runs only in a Tauri window',
		});
	const opened = await openRoot(path, create);
	if (opened.error !== null) return deviceRefusal(opened.error.cause, path);
	const { root, watch } = opened.data;
	const device = createDeviceClient(contract, tauriStore({ root, watch }));
	roots.set(device, root);
	return Ok(device);
}

/** The root each client opened, as the shell answered it. */
const roots = new WeakMap<object, string>();

/**
 * The root `device` was opened at, exactly as the shell answered it (its
 * canonical path): what the window's other native commands take to reach
 * the same folder, such as the recorder's and local transcription's `root`.
 * Throws for a client `openDevice` from `/tauri` did not return.
 */
export function rootOf(device: Client<Contract>): string {
	const root = roots.get(device);
	if (root === undefined)
		throw new Error('expected a client openDevice from /tauri returned');
	return root;
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
 * Ask the shell to open `root` and watch it: each call asks again, so a
 * folder that came back opens, and one that went is refused.
 */
async function openRoot(
	root: string,
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
