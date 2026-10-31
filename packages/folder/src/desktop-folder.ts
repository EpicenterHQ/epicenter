/**
 * A standalone desktop app's folder, as its page sees it (decisions 81 and
 * 82): where the app keeps the person's files, or null until they choose;
 * its machine-local settings (`settings.md`, opened as `config`); whether
 * Epicenter syncs the folder; "Sync with Epicenter"; and "Choose folder…".
 *
 * The roots come from `appFolders()`, which `epicenter-standalone` set before
 * the page ran. Choosing a folder is the shell's `choose_folder` command,
 * which admits the answer (or says in one line why not) and replaces the
 * window with one bound to the new folder; that window records it with
 * `rememberFolder`.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { invoke } from '@tauri-apps/api/core';
import {
	type AppConfig,
	appConfig,
	appFolders,
	rememberFolder,
} from './app-config.js';
import { syncedWithEpicenter, syncWithEpicenter } from './epicenter-sync.js';
import { openDevice } from './tauri.js';

/** Whether Epicenter syncs the folder, as far as the window can tell. */
export type FolderSync = 'synced' | 'not-synced' | 'unknown';

/** What became of a request the shell answers: done, or why not. */
export type FolderRequest = { ok: true } | { ok: false; message: string };

/** Where the person can keep the app's files: the two offered folders, or one they pick. */
export type FolderPlace = 'epicenter' | 'app-data' | 'pick';

/** The window's folder and settings; see `desktopFolder`. */
export type DesktopFolder<TConfig extends Contract = AppConfig> = {
	/** Where the app keeps its files, or null until the person chooses. */
	readonly path: string | null;
	/** Why the folder remembered in `settings.md` was not opened, if it was not. */
	readonly problem: string | null;
	/** The two folders offered on first run, beside "Choose folder…". */
	readonly places: { readonly epicenter: string; readonly appData: string };
	/** The app's machine-local `settings.md`, never synced. */
	readonly config: Client<TConfig>;
	/**
	 * Recording `path` in `settings.md`, which starts as the window opens on
	 * a folder the person chose, so the next launch opens it again.
	 */
	readonly remembered: Promise<FolderRequest>;
	/** Asks again each call: Epicenter may set the folder up while the app is open. */
	synced(): Promise<FolderSync>;
	/**
	 * "Sync with Epicenter": ask the computer to open Epicenter with a request
	 * to sync this folder (`epicenter://init`). Ok means the request was
	 * made, not that Epicenter set anything up.
	 */
	syncWithEpicenter(): Promise<FolderRequest>;
	/**
	 * Keep the app's files at `place`: the shell admits it (or says why not),
	 * and the app moves there in a new window as this one closes. Wait for
	 * saves before asking. Ok without moving when the person cancels.
	 */
	choose(place: FolderPlace): Promise<FolderRequest>;
};

const refused = (message: string): FolderRequest => ({ ok: false, message });

/**
 * This window's folder and settings, or null outside a standalone app's
 * window. `contract` is the URL the app's contract is published at (an app
 * constant: deployment, not data); `config` is the app's settings contract
 * when it keeps more than `folder` there (`defineAppConfig`).
 *
 * ```ts
 * const folder = desktopFolder({ contract: CONTRACT_URL });
 * const device = folder?.path ? openDevice(capture, { path: folder.path }) : null;
 * ```
 */
export function desktopFolder<TConfig extends Contract = AppConfig>({
	contract,
	config: settings = appConfig as Contract as TConfig,
}: {
	contract: string;
	config?: TConfig;
}): DesktopFolder<TConfig> | null {
	const folders = appFolders();
	if (folders === null) return null;
	const config = openDevice(settings, { path: folders.config });
	const path = folders.folder;
	return {
		path,
		problem: folders.problem,
		places: folders.places,
		config,
		remembered:
			path === null
				? Promise.resolve({ ok: true })
				: rememberFolder(config as unknown as Client<AppConfig>, path).then(
						({ error }) =>
							error === null ? { ok: true } : refused(error.message),
					),
		async synced() {
			if (path === null) return 'unknown';
			const { data, error } = await syncedWithEpicenter({ path });
			if (error !== null) return 'unknown';
			return data ? 'synced' : 'not-synced';
		},
		async syncWithEpicenter() {
			if (path === null) return refused('Choose a folder first.');
			const { error } = await syncWithEpicenter({ path, contract });
			return error === null ? { ok: true } : refused(error.message);
		},
		choose: (place) =>
			invoke<boolean>('choose_folder', { place }).then(
				() => ({ ok: true }) as const,
				(cause: unknown) => refused(String(cause)),
			),
	};
}
