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
 * Tauri decides which folders a window may open, through its runtime
 * file-system scope: the standalone shell allows the app's default data
 * folder at startup, and the folder picker (`chooseFolder`) allows the
 * folder a person picks, which persisted-scope keeps across launches. No
 * capability names a folder. A `folder` written by hand or by an agent
 * opens as `NotGranted` until the person picks it.
 *
 * ```ts
 * const appData = await openAppData(captureSettings);
 * if (appData.error !== null) return appData;
 * const device = await openDataFolder(capture, { appData: appData.data });
 * ```
 */
import type {
	Client,
	ClientError,
	Contract,
} from '@epicenter/definition/contract';
import { getName } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir, homeDir, join } from '@tauri-apps/api/path';
import { Ok, type Result } from 'wellcrafted/result';
import { OpenDeviceError } from './errors.js';
import { commands } from './native/bindings.gen.js';
import { deviceRefusal } from './native/open-refusal.js';
import {
	type FolderSettings,
	rememberFolder,
	type SettingsContract,
} from './settings.js';
import { openDevice } from './tauri.js';

/** Whether Epicenter syncs the folder, as far as the window can tell. */
export type FolderSync = 'synced' | 'not-synced' | 'unknown';

/** What became of a request the shell answers: done, or why not. */
export type FolderRequest = { ok: true } | { ok: false; message: string };

/**
 * The AppData root's client, through the app's own settings contract (its
 * `settings.md` with `folder`, and any other settings notes): this
 * computer's settings, never synced. The shell bound the window to this
 * directory before the page ran.
 */
export async function openAppData<TContract extends SettingsContract>(
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
 * The data root's client: the folder `appData`'s `settings.md` names, or
 * the default `~/Epicenter/<productName>` when it names none (`getName()`,
 * the configured `productName`, which the development configuration
 * overrides). Only the default is made when missing; a chosen folder that
 * is gone is `Missing`, never made again and never replaced by another.
 */
export async function openDataFolder<TContract extends Contract>(
	contract: TContract,
	{ appData }: { appData: FolderSettings },
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
 * The native folder picker, starting `at` a folder: the canonical path of
 * the folder picked, or `null` when the person cancels. The picker answers
 * the path the person reached, which may pass through a link (`/tmp` is
 * `/private/tmp` on macOS); the shell's `resolve_folder` answers the one
 * spelling, so a folder is remembered the same way whichever way it was
 * picked. Picking allows the folder (and everything in it) in Tauri's
 * file-system scope, which persisted-scope keeps, so `openDevice` opens it
 * from then on. It is the dialog plugin's `open` command, as
 * `@tauri-apps/plugin-dialog`'s `open()` sends it; the window's capability
 * grants `dialog:allow-open`.
 */
export async function chooseFolder({
	title,
	at,
}: {
	title: string;
	at?: string;
}): Promise<Result<string | null, OpenDeviceError>> {
	let picked: string | null;
	try {
		picked = await invoke<string | null>('plugin:dialog|open', {
			options: {
				title,
				directory: true,
				recursive: true,
				multiple: false,
				canCreateDirectories: true,
				defaultPath: at,
			},
		});
	} catch (cause) {
		return OpenDeviceError.StorageUnavailable({ cause });
	}
	return picked === null ? Ok(null) : canonicalFolder(picked);
}

/**
 * "Choose folder…", "Allow access" and "Choose data folder…": the picker
 * (`chooseFolder`) at `at`, then the folder picked remembered as `folder` in
 * `appData`'s `settings.md` by its canonical path, or forgotten when it is
 * the default folder. `true` once remembered, `false` when the person
 * cancelled; the caller opens the roots again.
 */
export async function pickDataFolder(
	appData: FolderSettings,
	options: { title: string; at?: string },
): Promise<Result<boolean, OpenDeviceError | ClientError>> {
	const picked = await chooseFolder(options);
	if (picked.error !== null) return picked;
	if (picked.data === null) return Ok(false);
	const remembered = await rememberFolder(
		appData,
		(await isDefaultFolder(picked.data)) ? undefined : picked.data,
	);
	if (remembered.error !== null) return remembered;
	return Ok(true);
}

/**
 * Whether the canonical `folder` is the default data folder, which may be
 * named through a link (a home folder under `/tmp`) or not be there yet:
 * compared by its canonical path when the shell can resolve it.
 */
async function isDefaultFolder(folder: string): Promise<boolean> {
	const fallback = await defaultDataFolder();
	if (fallback.error !== null) return false;
	const resolved = await canonicalFolder(fallback.data);
	return folder === (resolved.data ?? fallback.data);
}

/** The canonical path of `folder`, which Tauri's scope must allow. */
async function canonicalFolder(
	folder: string,
): Promise<Result<string, OpenDeviceError>> {
	try {
		const resolved = await commands.resolveFolder(folder);
		return resolved.error === null
			? Ok(resolved.data)
			: deviceRefusal(resolved.error, folder);
	} catch (cause) {
		return deviceRefusal(cause, folder);
	}
}
