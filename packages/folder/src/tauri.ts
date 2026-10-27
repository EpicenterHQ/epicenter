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
