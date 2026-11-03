/**
 * `@epicenter/folder/tauri`: open a root the desktop shell named as a
 * contract's typed client (`openDevice`). The page names a root (`Data` or
 * `AppData`), never a path; the shell answers each storage command, and its
 * watcher sends the paths that changed. A standalone app opens its two roots
 * with `openAppData` and `openDataFolder`.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { Channel, isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ChangeListener, ChangeSource } from './changes.js';
import { createDeviceClient } from './device/client.js';
import { tauriStore } from './device/tauri-store.js';
import { OpenDeviceError } from './errors.js';
import {
	commands,
	type FolderChanged,
	type Root,
} from './native/bindings.gen.js';
import { rootRefusal } from './native/open-refusal.js';

export {
	type FolderRequest,
	openAppData,
	openDataFolder,
} from './desktop-folder.js';
export { syncedWithEpicenter, syncWithEpicenter } from './epicenter-sync.js';
export { OpenDeviceError } from './errors.js';
export type { Root } from './native/bindings.gen.js';

/**
 * The typed client of `contract` over the root the shell named `root`, once
 * the shell opened it and started watching it. The shell opens whatever is
 * at the root's path, following a link there, and makes the folder when
 * nothing is there; a link whose target is gone is `Disconnected`, and
 * nothing is made.
 *
 * An `Err` says why nothing opened (`OpenDeviceError`); a contract that is
 * not well formed throws.
 *
 * ```ts
 * const device = await openDevice(notes, { root: 'Data' });
 * if (device.error !== null) return device;
 * ```
 */
export async function openDevice<TContract extends Contract>(
	contract: TContract,
	{ root }: { root: Root },
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	if (!isTauri())
		return OpenDeviceError.StorageUnavailable({
			cause: 'openDevice from /tauri runs only in a Tauri window',
		});
	const opened = await openRoot(root);
	if (opened.error !== null) return rootRefusal(opened.error.cause);
	const { path, watch } = opened.data;
	const device = createDeviceClient(contract, tauriStore({ root, watch }));
	opens.set(device, { root, path });
	return Ok(device);
}

/** The root each client opened, and the path the shell answered for it. */
const opens = new WeakMap<object, { root: Root; path: string }>();

/** What `openDevice` from `/tauri` recorded for `device`, or a throw. */
function openOf(device: Client<Contract>) {
	const open = opens.get(device);
	if (open === undefined)
		throw new Error('expected a client openDevice from /tauri returned');
	return open;
}

/**
 * The root `device` was opened at, by name: what the window's other native
 * commands take to reach the same folder, such as the recorder's and local
 * transcription's `root`. Throws for a client `openDevice` from `/tauri` did
 * not return.
 */
export function rootOf(device: Client<Contract>): Root {
	return openOf(device).root;
}

/**
 * The path of `device`'s root as the shell named it
 * (`/Users/me/Epicenter/whispering`), to show a person. No command takes
 * it. Throws for a client `openDevice` from `/tauri` did not return.
 */
export function displayPath(device: Client<Contract>): string {
	return openOf(device).path;
}

/** A root the shell opened: the path `rootPath` answered to show, and its watcher's changes. */
type OpenedRoot = { path: string; watch: ChangeSource };

/** Why the shell opened no root: its `RootError`, or what Tauri rejected with. */
type NotOpened = { cause: unknown };

/**
 * Who hears each root's watcher. The shell sends a root's changes to the
 * last channel this page opened it with, so every channel opened for a root
 * tells the same listeners, and every handle over the root hears them
 * whichever opened last.
 */
const listeners = new Map<Root, Set<ChangeListener>>();

/**
 * Ask the shell to open `root` and watch it: each call asks again, so a
 * folder that came back opens, and one that went is refused.
 */
async function openRoot(root: Root): Promise<Result<OpenedRoot, NotOpened>> {
	const known = listeners.get(root) ?? new Set<ChangeListener>();
	const channel = new Channel<FolderChanged>();
	channel.onmessage = ({ paths }) => {
		for (const listener of known) listener(paths);
	};
	let opened: Awaited<ReturnType<typeof commands.openRoot>>;
	let shown: Awaited<ReturnType<typeof commands.rootPath>>;
	try {
		opened = await commands.openRoot(root, channel);
		if (opened.error !== null) return Err({ cause: opened.error });
		// The one absolute path the page holds, only to show.
		shown = await commands.rootPath(root);
	} catch (cause) {
		return Err({ cause });
	}
	if (shown.error !== null) return Err({ cause: shown.error });
	listeners.set(root, known);
	return Ok({
		path: shown.data,
		watch(listener) {
			known.add(listener);
			return () => known.delete(listener);
		},
	});
}
