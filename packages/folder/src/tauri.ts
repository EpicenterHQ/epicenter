/**
 * `@epicenter/folder/tauri`: open a root the desktop shell named as a
 * contract's typed client (`openDevice`). The page names a root (`Data` or
 * `AppData`), never a path; the shell answers each storage command, and its
 * watcher sends the paths that changed. An app does not call it: its
 * `openFolder` opens the data folder (`Data`), and what a capability keeps
 * on this computer goes to `AppData` through `localFile` from
 * `@epicenter/local`.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ChangeListener, ChangeSource } from './changes.js';
import { createDeviceClient } from './device/client.js';
import { tauriStore } from './device/tauri-store.js';
import { OpenFolderError, RevealRootError } from './errors.js';
import {
	commands,
	type FolderEvent,
	type Root,
} from './native/bindings.gen.js';
import { rootRefusal } from './native/open-refusal.js';
import { openOf, recordOpen } from './native/opens.js';

export type { FolderRequest } from './desktop-folder.js';
export { syncedWithEpicenter, syncWithEpicenter } from './epicenter-sync.js';
export { OpenFolderError } from './errors.js';
export type { Root } from './native/bindings.gen.js';

/**
 * The typed client of `contract` over the root the shell named `root`, once
 * the shell opened it and started watching it. The shell opens whatever is
 * at the root's path, following a link there, and makes the folder when
 * nothing is there; a link whose target is gone is `Disconnected`, and
 * nothing is made.
 *
 * An `Err` says why nothing opened (`OpenFolderError`); a contract that is
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
): Promise<Result<Client<TContract>, OpenFolderError>> {
	if (!isTauri())
		return OpenFolderError.StorageUnavailable({
			cause: 'openDevice from /tauri runs only in a Tauri window',
		});
	const opened = await openRoot(root);
	if (opened.error !== null) return rootRefusal(opened.error.cause);
	const { path, watch } = opened.data;
	const device = createDeviceClient(contract, tauriStore({ root, watch }));
	recordOpen(device, { root, path });
	return Ok(device);
}

/**
 * The root `device` was opened at, by name: what the window's other native
 * commands take to reach the same folder. Throws for a client `openDevice`
 * from `/tauri` did not return.
 */
export function rootOf(device: Client<Contract>): Root {
	return openOf(device).root;
}

/**
 * The path of `device`'s root as the shell named it
 * (`/Users/me/Epicenter/whispering`), to show a person. No command takes
 * it. Throws for a client `openDevice` from `/tauri` did not return; a
 * folder answers its own (`folder.displayPath()`).
 */
export function displayPath(device: Client<Contract>): string {
	return openOf(device).path;
}

/** Ask the shell to show the location it named for `root`, even if it did not open. */
export async function revealRoot(
	root: Root,
): Promise<Result<null, RevealRootError>> {
	try {
		const answer = await commands.revealRoot(root);
		if (answer.error !== null)
			return RevealRootError.Failed({
				cause:
					'message' in answer.error ? answer.error.message : answer.error.name,
			});
		return Ok(null);
	} catch (cause) {
		return RevealRootError.Failed({ cause });
	}
}

/** A root the shell opened: its display path and watcher's changes. */
type OpenedRoot = { path: string; watch: ChangeSource };

/** Why the shell opened no root: its `RootError`, or what Tauri rejected with. */
type NotOpened = { cause: unknown };

/**
 * Ask the shell to open `root` and watch it: each call asks again, so a
 * folder that came back opens, and one that went is refused.
 */
async function openRoot(root: Root): Promise<Result<OpenedRoot, NotOpened>> {
	const listeners = new Set<ChangeListener>();
	let unlisten: () => void;
	try {
		// Keep a successful open's event listener for the page's lifetime: a
		// client may subscribe again after its last collection listener stops.
		unlisten = await listen<FolderEvent>('folder-changed', ({ payload }) => {
			if (payload.root !== root) return;
			for (const listener of listeners) listener(payload.paths);
		});
	} catch (cause) {
		return Err({ cause });
	}
	let opened: Awaited<ReturnType<typeof commands.openRoot>>;
	try {
		opened = await commands.openRoot(root);
	} catch (cause) {
		unlisten();
		return Err({ cause });
	}
	if (opened.error !== null) {
		unlisten();
		return Err({ cause: opened.error });
	}
	return Ok({
		path: opened.data,
		watch(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});
}
