/**
 * A standalone desktop app's folder in its page (decisions 81 and 82):
 * whether Epicenter syncs it, asked again whenever the window comes back
 * (Epicenter may set it up meanwhile), "Sync with Epicenter", and "Choose
 * folder…", which waits for saves before the window moves. Say so if
 * recording a chosen folder for the next launch failed.
 *
 * Call it while a component initializes; it listens for the window's focus
 * for that component's life.
 *
 * ```svelte
 * const sync = folderSync(folder);
 * <FolderSyncActions {sync} />
 * <Button onclick={sync.chooseFolder}>Choose folder…</Button>
 * ```
 */
import type {
	DesktopFolder,
	FolderRequest,
	FolderSync,
} from '@epicenter/folder/tauri';
import { toast } from '@epicenter/ui/sonner';
import { on } from 'svelte/events';
import { whenSaved } from './leave-guard.js';

export function folderSync(folder: Omit<DesktopFolder, 'config'>) {
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
	void folder.remembered.then((answer) => {
		if (!answer.ok)
			toast.error('The app may ask for its folder again next time', {
				description: answer.message,
			});
	});

	return {
		/** The folder's path, or null until the person chooses one. */
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
		/** Move to a folder the person picks; this window's saves land first. */
		chooseFolder() {
			void ask(async () => {
				await whenSaved();
				return folder.choose('pick');
			});
		},
	};
}

export type FolderSyncState = ReturnType<typeof folderSync>;
