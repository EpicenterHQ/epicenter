/**
 * `@epicenter/folder/tauri`: open the directory the desktop shell bound
 * to this window. The shell answers each storage command, and its watcher
 * sends the paths that changed.
 */
import { Channel, isTauri } from '@tauri-apps/api/core';
import { hostStorage } from './boundary.js';
import { OpenFolderError } from './errors.js';
import { commands, type FolderChanged } from './native/bindings.gen.js';
import { openRefusal } from './native/open-refusal.js';
import { tauriHostFiles } from './tauri-files.js';
import {
	createFolder,
	type Opened,
	type OpenOptions,
	type Tables,
} from './folder.js';
import { storageHost } from './storage.js';

export * from './contract.js';

export async function openFolder<const T extends Tables>(
	options: OpenOptions<T>,
): Opened<T> {
	if (!isTauri()) return OpenFolderError.NotTauri();
	let opened: Awaited<ReturnType<typeof commands.openFolder>>;
	const listeners = new Set<(paths: readonly string[] | null) => void>();
	const onChange = new Channel<FolderChanged>();
	onChange.onmessage = ({ paths }) => {
		for (const listener of listeners) listener(paths);
	};
	try {
		opened = await commands.openFolder(onChange);
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
	return createFolder(
		storageHost(hostStorage(tauriHostFiles()), {
			watch(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) onChange.onmessage = () => {};
				};
			},
		}),
		options,
	);
}
