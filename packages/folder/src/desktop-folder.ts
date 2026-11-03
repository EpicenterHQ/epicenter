/**
 * A standalone desktop app's two roots, which the shell names at startup:
 * its data folder, `<library root>/<name>` from its bundle identifier, and
 * its AppData root for machine-local settings. Each opens by name; the page
 * never holds either one's path except to show it (`displayPath`).
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import type { Result } from 'wellcrafted/result';
import type { OpenDeviceError } from './errors.js';
import { openDevice } from './tauri.js';

/** What became of a request the shell answers: done, or why not. */
export type FolderRequest = { ok: true } | { ok: false; message: string };

/** Open an app's machine-local settings contract at its AppData root. */
export async function openAppData<TContract extends Contract>(
	contract: TContract,
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	return openDevice(contract, { root: 'AppData' });
}

/**
 * Open the app's data folder, which the shell makes when nothing is at its
 * path. A data folder behind a link whose target is gone is `Disconnected`,
 * and nothing is made.
 */
export async function openDataFolder<TContract extends Contract>(
	contract: TContract,
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	return openDevice(contract, { root: 'Data' });
}
