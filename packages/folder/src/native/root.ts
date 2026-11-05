/**
 * A root the desktop shell named, opened as a store: the page names a root
 * (`Data`), never a path; the shell answers each storage command, and its
 * watcher sends the paths that changed. The desktop's `home` opens `Data`.
 */
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Changed, Store } from '../device/store.js';
import { tauriStore } from '../device/tauri-store.js';
import { OpenFolderError } from '../errors.js';
import { commands, type FolderEvent, type Root } from './bindings.gen.js';
import { rootRefusal } from './open-refusal.js';

/**
 * The store over the root the shell named `root`, once the shell opened it
 * and started watching it, with the path the shell answered for it (to
 * show a person; no command takes it). The shell opens whatever is at the
 * root's path, following a link there, and makes the folder when nothing
 * is there; a link whose target is gone is `Disconnected`, and nothing is
 * made. Each call asks again, so a folder that came back opens, and one
 * that went is refused.
 */
export async function openRoot(
	root: Root,
): Promise<Result<{ store: Store; path: string }, OpenFolderError>> {
	if (!isTauri())
		return OpenFolderError.StorageUnavailable({
			cause: 'the desktop folder opens only in a Tauri window',
		});
	const opened = await askShell(root);
	if (opened.error !== null) return rootRefusal(opened.error.cause);
	const { path, hear } = opened.data;
	return Ok({ store: tauriStore({ root, listen: hear }), path });
}

/** A root the shell opened: its display path, and how to hear its watcher. */
type OpenedRoot = { path: string; hear: (changed: Changed) => () => void };

/** Why the shell opened no root: its `RootError`, or what Tauri rejected with. */
type NotOpened = { cause: unknown };

/** Ask the shell to open `root` and watch it. */
async function askShell(root: Root): Promise<Result<OpenedRoot, NotOpened>> {
	const listeners = new Set<Changed>();
	let unlisten: () => void;
	try {
		// Keep a successful open's event listener for the page's lifetime: a
		// client may subscribe again after its last collection listener stops.
		unlisten = await listen<FolderEvent>('folder-changed', ({ payload }) => {
			if (payload.root !== root) return;
			for (const listener of listeners) listener(payload.paths ?? 'all');
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
		hear(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});
}
