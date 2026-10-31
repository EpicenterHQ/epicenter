/**
 * A standalone desktop app's two roots, as its page opens them (decisions 88
 * to 94). The AppData root is the operating system's application data
 * directory for the app: machine-local, never synced, its `settings.md`
 * holding `folder` only when the person chose a data folder. The data root
 * is the person's files: `folder`, or `~/Epicenter/<productName>` by default,
 * the app's configured name (`Capture`, or `Capture Dev` in development,
 * whose configuration also gives it its own AppData). Both are found with
 * Tauri's own APIs; the shell names no path to the page.
 *
 * Tauri decides which folders a window may open: the app's capability
 * allows its default data folder, and the folder picker (`chooseFolder`)
 * allows the folder a person picks, which persisted-scope keeps across
 * launches. A `folder` written by hand or by an agent opens as `NotGranted`
 * until the person picks it.
 *
 * ```ts
 * const appData = await openAppData();
 * if (appData.error !== null) return appData;
 * const device = await openDataFolder(capture, { appData: appData.data });
 * ```
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { getName } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir, homeDir, join } from '@tauri-apps/api/path';
import { Ok, type Result } from 'wellcrafted/result';
import { type AppConfig, appConfig } from './app-config.js';
import { OpenDeviceError } from './errors.js';
import { openDevice } from './tauri.js';

/** Whether Epicenter syncs the folder, as far as the window can tell. */
export type FolderSync = 'synced' | 'not-synced' | 'unknown';

/** What became of a request the shell answers: done, or why not. */
export type FolderRequest = { ok: true } | { ok: false; message: string };

/**
 * The AppData root's client: its `settings.md` (`appConfig`), never synced.
 * The shell bound the window to this directory before the page ran.
 */
export async function openAppData(): Promise<
	Result<Client<AppConfig>, OpenDeviceError>
> {
	let path: string;
	try {
		path = await appDataDir();
	} catch (cause) {
		return OpenDeviceError.StorageUnavailable({ cause });
	}
	return openDevice(appConfig, { path });
}

/**
 * The data root's client: the folder `appData`'s `settings.md` names, or
 * the default `~/Epicenter/<productName>` when it names none (`getName()`,
 * the configured `productName`, which the development configuration
 * overrides). Only the default is made when missing; a chosen folder that
 * is gone is `Missing`, never made again and never replaced by another.
 */
export async function openDataFolder<TContract extends Contract>(
	contract: TContract,
	{ appData }: { appData: Client<AppConfig> },
): Promise<Result<Client<TContract>, OpenDeviceError>> {
	const settings = await appData.settings.get({});
	if (settings.error !== null && settings.error.name !== 'NotFound')
		return OpenDeviceError.Unreadable({
			folder: 'settings.md',
			cause: settings.error,
		});
	const defaultFolder = await defaultDataFolder();
	if (defaultFolder.error !== null) return defaultFolder;
	const folder = settings.data?.folder ?? defaultFolder.data;
	return openDevice(contract, {
		path: folder,
		create: folder === defaultFolder.data,
	});
}

/** `~/Epicenter/<productName>`: the data folder `settings.md` names none of. */
export async function defaultDataFolder(): Promise<
	Result<string, OpenDeviceError>
> {
	try {
		return Ok(await join(await homeDir(), 'Epicenter', await getName()));
	} catch (cause) {
		return OpenDeviceError.StorageUnavailable({ cause });
	}
}

/**
 * The native folder picker, starting `at` a folder: the path picked, or
 * `null` when the person cancels. Picking allows the folder (and everything
 * in it) in Tauri's file-system scope, which persisted-scope keeps, so
 * `openDevice` opens it from then on. It is the dialog plugin's `open`
 * command, as `@tauri-apps/plugin-dialog`'s `open()` sends it; the window's
 * capability grants `dialog:allow-open`.
 */
export async function chooseFolder({
	title,
	at,
}: {
	title: string;
	at?: string;
}): Promise<Result<string | null, OpenDeviceError>> {
	try {
		const picked = await invoke<string | null>('plugin:dialog|open', {
			options: {
				title,
				directory: true,
				recursive: true,
				multiple: false,
				canCreateDirectories: true,
				defaultPath: at,
			},
		});
		return Ok(picked);
	} catch (cause) {
		return OpenDeviceError.StorageUnavailable({ cause });
	}
}
