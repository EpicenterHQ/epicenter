/**
 * A standalone desktop app's data folder in its page (decisions 81, 88 and
 * 89): whether Epicenter syncs it, asked again whenever the window comes
 * back (Epicenter may set it up meanwhile), "Sync with Epicenter", and
 * "Choose data folder…", which waits for saves, opens the folder picked with
 * its files where they are, remembers it, and reloads the page over it.
 *
 * `data-folder.svelte` makes it once the folder is open and sets it for the
 * components under it; the header reads it with `getFolderSync()`.
 *
 * ```svelte
 * const sync = getFolderSync();
 * <FolderSyncActions {sync} />
 * <Button onclick={sync.chooseDataFolder}>Choose data folder…</Button>
 * ```
 */
import type {
	DataFolder,
	DesktopFolder,
	FolderRequest,
	FolderSync,
} from '@epicenter/folder/tauri';
import { getContext, hasContext, setContext } from 'svelte';
import { on } from 'svelte/events';
import { whenSaved } from './leave-guard.js';

/** Call while a component initializes; it listens for the window's focus for that component's life. */
export function folderSync(
	desktop: Pick<DesktopFolder, 'choose'>,
	folder: DataFolder,
) {
	let state = $state<FolderSync>('unknown');
	let request = $state<{ tone: 'requested' | 'failed'; message: string }>();
	let asking = $state(false);

	async function check() {
		state = await folder.synced();
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
		/** The data folder's path. */
		get path() {
			return folder.path;
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
			void ask(
				() => folder.syncWithEpicenter(),
				'Asked your computer to open Epicenter. If it is installed, choose where to sync there.',
			);
		},
		/** "Choose data folder…": this window's saves land first; the page reloads over the folder picked. */
		chooseDataFolder() {
			void ask(async () => {
				await whenSaved();
				const answer = await desktop.choose();
				if (answer === null) return { ok: true };
				if (!answer.ok) return { ok: false, message: answer.refusal.message };
				window.location.reload();
				return { ok: true };
			});
		},
	};
}

export type FolderSyncState = ReturnType<typeof folderSync>;

const FOLDER_SYNC = Symbol('epicenter.folder-sync');

/** Give the components under this one the open data folder's sync. */
export function setFolderSync(sync: FolderSyncState): FolderSyncState {
	return setContext(FOLDER_SYNC, sync);
}

/** The open data folder's sync, which `data-folder.svelte` set above. Throws outside it. */
export function getFolderSync(): FolderSyncState {
	if (!hasContext(FOLDER_SYNC))
		throw new Error(
			'getFolderSync() was called outside the open data folder (data-folder.svelte)',
		);
	return getContext<FolderSyncState>(FOLDER_SYNC);
}
