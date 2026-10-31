/**
 * Whether Epicenter syncs the desktop app's folder, asked again whenever
 * the window regains focus (the person may have set it up in Epicenter
 * meanwhile), and the "Sync with Epicenter" request.
 */
import { toast } from '@epicenter/ui/sonner';
import { desktop } from '#platform/desktop';
import type { FolderSync } from '$lib/platform/types.js';

export function createSyncState(folder: string) {
	let state = $state<FolderSync | 'checking'>('checking');
	let asking = $state(false);

	async function check() {
		if (desktop === null) return;
		state = await desktop.folder.synced(folder);
	}

	return {
		get state() {
			return state;
		},
		get asking() {
			return asking;
		},
		check,
		/** Ask the computer to open Epicenter with a request to sync the folder. */
		async request() {
			if (desktop === null) return;
			asking = true;
			const { error } = await desktop.folder.syncWithEpicenter(folder);
			asking = false;
			if (error !== null)
				toast.error('Could not ask Epicenter to sync this folder', {
					description: `${error} Is Epicenter installed?`,
				});
			else
				toast.info('Asked your computer to open Epicenter', {
					description:
						'Choose where to sync the folder there. Whispering shows it as synced once Epicenter has set it up.',
				});
		},
	};
}
