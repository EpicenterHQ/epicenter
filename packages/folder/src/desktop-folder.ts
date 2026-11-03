/**
 * A standalone desktop app opens its data folder at the path derived by the
 * shell from its bundle identifier. Apps with machine-local settings also open the AppData
 * root through Tauri's path API. The shell grants the derived folder to this
 * window and answers its canonical path.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { appDataDir } from '@tauri-apps/api/path';
import type { Result } from 'wellcrafted/result';
import { OpenDeviceError } from './errors.js';
import { commands } from './native/bindings.gen.js';
import { dataFolderRefusal } from './native/open-refusal.js';
import { openDevice } from './tauri.js';

/** What became of a request the shell answers: done, or why not. */
export type FolderRequest = { ok: true } | { ok: false; message: string };

/** Open an app's machine-local settings contract at its AppData root. */
export async function openAppData<TContract extends Contract>(
	contract: TContract,
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	let path: string;
	try {
		path = await appDataDir();
	} catch (cause) {
		return OpenDeviceError.StorageUnavailable({ cause });
	}
	return openDevice(contract, { path });
}

/**
 * Open the shell's derived data folder, creating it when missing. A derived
 * folder behind a link whose target is gone is `Disconnected`, and nothing
 * is made.
 */
export async function openDataFolder<TContract extends Contract>(
	contract: TContract,
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	try {
		const folder = await commands.dataFolder();
		if (folder.error !== null) return dataFolderRefusal(folder.error);
		return openDevice(contract, { path: folder.data, create: true });
	} catch (cause) {
		return OpenDeviceError.StorageUnavailable({ cause });
	}
}
