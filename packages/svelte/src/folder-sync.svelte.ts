/**
 * The open data folder's path and Epicenter sync status in a desktop page.
 * The shell answers the path, which the page only shows; focus refreshes
 * whether Epicenter manages the folder.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import {
	displayPath,
	type FolderRequest,
	rootOf,
	syncedWithEpicenter,
	syncWithEpicenter,
} from '@epicenter/folder/tauri';
import { createContext } from 'svelte';
import { on } from 'svelte/events';

/**
 * Call while a component initializes; it listens for the window's focus for
 * that component's life. `device` is the data folder's client, and
 * `contract` is the URL the app's contract is published at (an app constant: deployment, not data).
 */
export function folderSync({
	device,
	contract,
}: {
	device: Client<Contract>;
	contract: string;
}) {
	const root = rootOf(device);
	const path = displayPath(device);
	let managed = $state(false);
	let request = $state<{ tone: 'requested' | 'failed'; message: string }>();
	let asking = $state(false);

	/** Ask the shell again; the native predicate reads Epicenter enrollment. */
	async function check() {
		const { data } = await syncedWithEpicenter({ root });
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
				const { error } = await syncWithEpicenter({ root, contract });
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
