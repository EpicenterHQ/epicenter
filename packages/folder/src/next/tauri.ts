/**
 * `@epicenter/folder/next/tauri`: open the directory the desktop shell bound
 * to this window. The shell answers each storage command, and its watcher
 * sends the paths that changed.
 */
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { hostStorage } from '../boundary.js';
import { OpenFolderError } from '../errors.js';
import { commands, events } from '../native/bindings.gen.js';
import { openRefusal } from '../native/open-refusal.js';
import { invalidTable } from '../paths.js';
import { tauriHostFiles } from '../tauri-files.js';
import {
	createFolder,
	type Opened,
	type OpenOptions,
	type Tables,
} from './folder.js';
import { storageHost } from './storage.js';

export * from './index.js';

export async function openFolder<const T extends Tables>(
	options: OpenOptions<T>,
): Opened<T> {
	const table = invalidTable(options.tables);
	if (table !== undefined) return OpenFolderError.InvalidTable({ table });
	if (!isTauri()) return OpenFolderError.NotTauri();
	let opened: Awaited<ReturnType<typeof commands.openFolder>>;
	try {
		opened = await commands.openFolder();
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	if (opened.error !== null) {
		const { error } = opened;
		// Tauri also rejects with strings for missing commands or permissions;
		// only an object with a name is the shell's own refusal.
		if (typeof error !== 'object' || error === null || !('name' in error))
			return OpenFolderError.Unavailable({ cause: error });
		return openRefusal(error);
	}
	const listeners = new Set<(paths: readonly string[] | null) => void>();
	let stop: () => void;
	try {
		stop = await events
			.folderChanged(getCurrentWebview())
			.listen(({ payload }) => {
				const paths: unknown =
					typeof payload === 'object' && payload !== null
						? payload.paths
						: undefined;
				const named =
					Array.isArray(paths) &&
					paths.every((path) => typeof path === 'string')
						? paths
						: null;
				for (const listener of listeners) listener(named);
			});
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	return createFolder(
		storageHost(hostStorage(tauriHostFiles()), {
			watch(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) stop();
				};
			},
		}),
		options,
	);
}
