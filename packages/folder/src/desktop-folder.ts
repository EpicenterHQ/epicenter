/**
 * A standalone desktop app's two roots, as its page sees them (decisions 88
 * and 89). The window starts with only its AppData root, whose `settings.md`
 * the page reads through `config`; the page then asks the shell for its data
 * root (`open_data_folder`): the folder `settings.md` names, or the default
 * `~/Epicenter/<App>` when it names none. The shell admits it or says why not
 * (`DataFolderRefusal`), and the page opens its data device at the path the
 * shell answered, or shows its recovery screen. Nothing falls back silently.
 *
 * Open the data device only after the answer: the window's watch follows its
 * data root, and a device that listened before would keep the AppData root's.
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

/**
 * Why the data folder was not opened: not a folder the app may use
 * (`refused`), a chosen folder that is gone (`missing`), one the shell could
 * not make or give the window (`unavailable`), or `settings.md` that could
 * not be read or written (`settings`).
 */
export type DataFolderRefusal = {
	kind: 'refused' | 'missing' | 'unavailable' | 'settings';
	message: string;
};

/** The open data root: its path, and its sync with Epicenter. */
export type DataFolder = {
	/** The root's path, as the shell granted it: open the data device here. */
	readonly path: string;
	/** Asks again each call: Epicenter may set the folder up while the app is open. */
	synced(): Promise<FolderSync>;
	/**
	 * "Sync with Epicenter": ask the computer to open Epicenter with a request
	 * to sync this folder (`epicenter://init`). Ok means the request was
	 * made, not that Epicenter set anything up.
	 */
	syncWithEpicenter(): Promise<FolderRequest>;
};

/** The data root, or why it was not opened. */
export type DataFolderAnswer =
	| { ok: true; folder: DataFolder }
	| { ok: false; refusal: DataFolderRefusal };

/** The window's roots and the requests that open its data root; see `desktopFolder`. */
export type DesktopFolder<TConfig extends Contract = AppConfig> = {
	/** The AppData root's settings (`settings.md`), never synced. */
	readonly config: Client<TConfig>;
	/** The data folder opened when `settings.md` names none. */
	readonly defaultPath: string;
	/** Open the folder `settings.md` names, or the default: at startup, and Retry. */
	open(): Promise<DataFolderAnswer>;
	/** "Use the default folder": open it, and forget the chosen one. */
	openDefault(): Promise<DataFolderAnswer>;
	/**
	 * "Choose data folder…": the native picker, then open the folder picked,
	 * with its files where they are, and remember it. `null` when the person
	 * cancels. The window's data root changes: wait for saves before asking,
	 * and reload the page after an ok answer.
	 */
	choose(): Promise<DataFolderAnswer | null>;
};

const refusalOf = (cause: unknown): DataFolderRefusal => {
	if (
		typeof cause === 'object' &&
		cause !== null &&
		'kind' in cause &&
		'message' in cause &&
		typeof cause.message === 'string'
	)
		return cause as DataFolderRefusal;
	return { kind: 'unavailable', message: String(cause) };
};

const settingsRefusal = (message: string): DataFolderAnswer => ({
	ok: false,
	refusal: { kind: 'settings', message: `settings.md: ${message}` },
});

/**
 * This window's roots, or null outside a standalone app's window. `contract`
 * is the URL the app's contract is published at (an app constant:
 * deployment, not data); `config` is the app's settings contract when it
 * keeps more than `folder` there (`defineAppConfig`).
 *
 * ```ts
 * const desktop = desktopFolder({ contract: CONTRACT_URL });
 * const answer = await desktop.open();
 * if (answer.ok) setRepo(openDevice(capture, { path: answer.folder.path }));
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
	const settingsClient = config as unknown as Client<AppConfig>;

	function dataFolder(path: string): DataFolder {
		return {
			path,
			async synced() {
				const { data, error } = await syncedWithEpicenter({ path });
				if (error !== null) return 'unknown';
				return data ? 'synced' : 'not-synced';
			},
			async syncWithEpicenter() {
				const { error } = await syncWithEpicenter({ path, contract });
				return error === null
					? { ok: true }
					: { ok: false, message: error.message };
			},
		};
	}

	/** Ask the shell for `folder` (the default for `null`). */
	const openData = (folder: string | null): Promise<DataFolderAnswer> =>
		invoke<string>('open_data_folder', { folder }).then(
			(path) => ({ ok: true, folder: dataFolder(path) }),
			(cause: unknown) => ({ ok: false, refusal: refusalOf(cause) }),
		);

	return {
		config,
		defaultPath: folders.default,
		async open() {
			const read = await settingsClient.settings.get({});
			if (read.error !== null && read.error.name !== 'NotFound')
				return settingsRefusal(read.error.message);
			return openData(read.data?.folder ?? null);
		},
		async openDefault() {
			const answer = await openData(null);
			if (!answer.ok) return answer;
			const { error } = await rememberFolder(settingsClient, undefined);
			return error === null ? answer : settingsRefusal(error.message);
		},
		async choose() {
			let picked: string | null;
			try {
				picked = await invoke<string | null>('choose_data_folder');
			} catch (cause) {
				return { ok: false, refusal: refusalOf(cause) };
			}
			if (picked === null) return null;
			const answer = await openData(picked);
			if (!answer.ok) return answer;
			const { error } = await rememberFolder(
				settingsClient,
				picked === folders.default ? undefined : picked,
			);
			return error === null ? answer : settingsRefusal(error.message);
		},
	};
}
