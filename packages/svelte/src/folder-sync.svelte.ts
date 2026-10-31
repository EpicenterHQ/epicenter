/**
 * A standalone desktop app's data folder in its page (decisions 81, 88 to
 * 94): its path, whether Epicenter syncs it, asked again whenever the window
 * comes back (Epicenter may set it up meanwhile), "Sync with Epicenter", and
 * "Choose data folder…", which waits for saves, lets the person pick a folder
 * in the native picker (which allows it), remembers it in the AppData
 * `settings.md`, and reloads the page over it, its files where they are.
 *
 * The app's desktop root makes it once the roots are open and sets it for
 * the components under it; the header reads it with `getFolderSync()`.
 *
 * ```svelte
 * setFolderSync(folderSync({ appData, contract: CONTRACT_URL }));
 * const sync = getFolderSync();
 * <FolderSyncActions {sync} />
 * <Button onclick={sync.chooseDataFolder}>Choose data folder…</Button>
 * ```
 */
import type { Client } from '@epicenter/definition/contract';
import {
	type AppConfig,
	chooseFolder,
	defaultDataFolder,
	type FolderRequest,
	type FolderSync,
	rememberFolder,
	syncedWithEpicenter,
	syncWithEpicenter,
} from '@epicenter/folder/tauri';
import { createContext } from 'svelte';
import { on } from 'svelte/events';
import { whenSaved } from './leave-guard.js';

/**
 * Call while a component initializes; it listens for the window's focus for
 * that component's life. `contract` is the URL the app's contract is
 * published at (an app constant: deployment, not data).
 */
export function folderSync({
	appData,
	contract,
}: {
	appData: Client<AppConfig>;
	contract: string;
}) {
	let path = $state<string>();
	let state = $state<FolderSync>('unknown');
	let request = $state<{ tone: 'requested' | 'failed'; message: string }>();
	let asking = $state(false);

	/** The data folder the window opened: the one `settings.md` names, or the default. */
	async function opened(): Promise<string | undefined> {
		const settings = await appData.settings.get({});
		if (settings.data?.folder !== undefined) return settings.data.folder;
		const fallback = await defaultDataFolder();
		return fallback.error === null ? fallback.data : undefined;
	}

	async function check() {
		path ??= await opened();
		if (path === undefined) return;
		const { data, error } = await syncedWithEpicenter({ path });
		state = error !== null ? 'unknown' : data ? 'synced' : 'not-synced';
	}

	async function ask(action: () => Promise<FolderRequest>, requested?: string) {
		asking = true;
		request = undefined;
		const answer = await action();
		asking = false;
		if (!answer.ok) request = { tone: 'failed', message: answer.message };
		else if (requested !== undefined)
			request = { tone: 'requested', message: requested };
	}

	$effect(() => {
		void check();
		return on(window, 'focus', () => void check());
	});

	return {
		/** The data folder's path, once read. */
		get path() {
			return path;
		},
		/** Whether Epicenter syncs the folder, as of the window's last focus. */
		get state() {
			return state;
		},
		/** The last request's answer, to show beside the button, if any. */
		get request() {
			return request;
		},
		/** True while the shell is answering. */
		get asking() {
			return asking;
		},
		syncWithEpicenter() {
			void ask(async () => {
				const at = path ?? (await opened());
				if (at === undefined)
					return { ok: false, message: 'The data folder is not known yet.' };
				const { error } = await syncWithEpicenter({ path: at, contract });
				return error === null
					? { ok: true }
					: { ok: false, message: error.message };
			}, 'Asked your computer to open Epicenter. If it is installed, choose where to sync there.');
		},
		/** "Choose data folder…": this window's saves land first; the page reloads over the folder picked. */
		chooseDataFolder() {
			void ask(async () => {
				await whenSaved();
				const picked = await chooseFolder({
					title: 'Choose the data folder',
					at: path,
				});
				if (picked.error !== null)
					return { ok: false, message: picked.error.message };
				if (picked.data === null) return { ok: true };
				const fallback = await defaultDataFolder();
				const folder =
					fallback.error === null && picked.data === fallback.data
						? undefined
						: picked.data;
				const remembered = await rememberFolder(appData, folder);
				if (remembered.error !== null)
					return { ok: false, message: remembered.error.message };
				window.location.reload();
				return { ok: true };
			});
		},
	};
}

export type FolderSyncState = ReturnType<typeof folderSync>;

const [getContext, setContext] = createContext<FolderSyncState>();

/** Give the components under this one the open data folder's sync. */
export function setFolderSync(sync: FolderSyncState): FolderSyncState {
	return setContext(sync);
}

/** The open data folder's sync, which the app's desktop root set. Throws outside it. */
export function getFolderSync(): FolderSyncState {
	return getContext();
}
