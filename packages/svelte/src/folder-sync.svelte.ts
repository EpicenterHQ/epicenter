/**
 * A standalone desktop app's data folder in its page (decisions 81, 88 to
 * 94): its path as the shell opened it (`rootOf`), whether Epicenter syncs
 * it, asked again whenever the window comes back (Epicenter may set it up
 * meanwhile), "Sync with Epicenter", and
 * "Choose data folder…", which waits for saves, lets the person pick a folder
 * in the native picker (which allows it), remembers it in the AppData
 * `settings.md`, and reloads the page over it, its files where they are.
 *
 * The app's desktop root makes it once the roots are open and sets it for
 * the components under it; the header reads it with `getFolderSync()`.
 *
 * ```svelte
 * setFolderSync(folderSync({ appData, device, contract: CONTRACT_URL }));
 * const sync = getFolderSync();
 * <FolderSyncActions {sync} />
 * <Button onclick={sync.chooseDataFolder}>Choose data folder…</Button>
 * ```
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import {
	type FolderRequest,
	type FolderSettings,
	pickDataFolder,
	rootOf,
	syncedWithEpicenter,
	syncWithEpicenter,
} from '@epicenter/folder/tauri';
import { createContext } from 'svelte';
import { on } from 'svelte/events';
import { whenSaved } from './leave-guard.js';

/**
 * Call while a component initializes; it listens for the window's focus for
 * that component's life. `device` is the data folder's client, `appData`
 * the AppData root's that names it, and `contract` the URL the app's
 * contract is published at (an app constant: deployment, not data).
 */
export function folderSync({
	appData,
	device,
	contract,
}: {
	appData: FolderSettings;
	device: Client<Contract>;
	contract: string;
}) {
	const path = rootOf(device);
	let synced = $state(false);
	let request = $state<{ tone: 'requested' | 'failed'; message: string }>();
	let asking = $state(false);

	/** Ask the shell again; a folder it cannot answer for counts as not synced. */
	async function check() {
		const { data } = await syncedWithEpicenter({ path });
		synced = data === true;
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
		/** The data folder's path, as the shell opened it. */
		path,
		/** Whether Epicenter syncs the folder, as of the window's last focus. */
		get synced() {
			return synced;
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
				const { error } = await syncWithEpicenter({ path, contract });
				return error === null
					? { ok: true }
					: { ok: false, message: error.message };
			}, 'Asked your computer to open Epicenter. If it is installed, choose where to sync there.');
		},
		/** "Choose data folder…": this window's saves land first; the page reloads over the folder picked. */
		chooseDataFolder() {
			void ask(async () => {
				await whenSaved();
				const picked = await pickDataFolder(appData, {
					title: 'Choose the data folder',
					at: path,
				});
				if (picked.error !== null)
					return { ok: false, message: picked.error.message };
				if (picked.data) window.location.reload();
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
