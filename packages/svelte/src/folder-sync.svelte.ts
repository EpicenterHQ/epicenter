/**
 * The open data folder's path and Epicenter sync status in a desktop page.
 * The shell answers the path, which the page only shows; focus refreshes
 * whether Epicenter manages the folder.
 */
import {
	type FolderRequest,
	syncedWithEpicenter,
	syncWithEpicenter,
} from '@epicenter/folder/tauri';
import { createContext } from 'svelte';
import { on } from 'svelte/events';

/**
 * Call while a component initializes; it listens for the window's focus for
 * that component's life. `path` is the data folder's path as the shell named
 * it (`folder.displayPath()`), and
 * `site` is the app's production site.
 */
export function folderSync({ path, site }: { path: string; site: string }) {
	let managed = $state(false);
	let request = $state<{ tone: 'requested' | 'failed'; message: string }>();
	let asking = $state(false);

	/** Ask the shell again; the native predicate reads Epicenter enrollment. */
	async function check() {
		const { data } = await syncedWithEpicenter();
		managed = data === true;
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
		/** The data folder's path, as the shell named it, to show. */
		path,
		/** Whether Epicenter manages local history, as of the last focus. */
		get managed() {
			return managed;
		},
		/** The last request's answer, to show beside the button, if any. */
		get request() {
			return request;
		},
		/** True while the shell is answering. */
		get asking() {
			return asking;
		},
		requestSetup() {
			void ask(async () => {
				const { error } = await syncWithEpicenter({
					contract: `${site}/contract.json`,
				});
				return error === null
					? { ok: true }
					: { ok: false, message: error.message };
			}, 'Asked your computer to open Epicenter. Set up the folder there, then connect a repository to use it on other devices.');
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
