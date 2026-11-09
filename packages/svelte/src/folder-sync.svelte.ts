/**
 * The open data folder's path, and whether Epicenter syncs it, in a Tauri
 * window (ADR-0822). A desktop app never syncs: Epicenter, when it is
 * installed, keeps the folder in sync across devices, and the shell reads
 * the record Epicenter keeps of this folder (never writing it) to say so.
 * Focus asks again. The shell's code loads with the first question, so a
 * page that never shows this never loads it.
 */
import type { FolderRecord } from '@epicenter/folder/platform';
import { createContext } from 'svelte';
import { on } from 'svelte/events';

const shell = () => import('@epicenter/folder/tauri');

/** Where a person gets Epicenter, which syncs a desktop app's folder. */
export const GET_EPICENTER = 'https://epicenter.sh';

/**
 * Call while a component initializes; it listens for the window's focus for
 * that component's life. `path` is the data folder's path as the shell named
 * it (`folder.displayPath()`).
 */
export function folderSync({ path }: { path: string }) {
	let record = $state<FolderRecord | null>(null);

	/** Ask the shell again for Epicenter's record of this folder. */
	async function check() {
		record = await (await shell()).syncedRecord();
	}

	$effect(() => {
		void check();
		return on(window, 'focus', () => void check());
	});

	return {
		/** The data folder's path, as the shell named it, to show. */
		path,
		/** Whether Epicenter syncs this folder, as of the last focus. */
		get synced() {
			return record !== null;
		},
		/** Epicenter's record of this folder, as of the last focus, or null. */
		get record() {
			return record;
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
