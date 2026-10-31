/**
 * The desktop app's folder, as its page sees it (decisions 81 and 82).
 * Honeycrisp's native shell (`epicenter-standalone`) asked on first run where
 * to keep the notes, remembered the answer as `folder` in its `settings.md`,
 * and bound the folder to this window. The page learns the folder's path
 * (`folder_path`) to show it and to name it to Epicenter: "Sync with
 * Epicenter" sends `epicenter://init?path=<folder>&contract=<CONTRACT_URL>`
 * (`syncWithEpicenter({ path, contract })` from `@epicenter/folder/tauri`).
 * Whether Epicenter syncs it is read when the page opens and again whenever
 * the window regains focus, since that happens in Epicenter, another
 * program.
 *
 * Imported only by the desktop root.
 */
import {
	syncedWithEpicenter,
	syncWithEpicenter,
} from '@epicenter/folder/tauri';
import { toast } from '@epicenter/ui/sonner';
import { invoke } from '@tauri-apps/api/core';
import { onMount } from 'svelte';
import { on } from 'svelte/events';
import { CONTRACT_URL } from './contract.js';
import type { DesktopFolder, SyncRequest } from './desktop-context.js';
import { syncRequestOutcome } from './sync-request.js';

/** The window's folder for the header, followed while the calling component is mounted. */
export function createDesktopFolder(): DesktopFolder {
	let location = $state<string>();
	let synced = $state<boolean>();
	let request = $state<SyncRequest>();

	async function read() {
		location = await invoke<string>('folder_path').catch(() => undefined);
		if (location === undefined) return;
		const { data, error } = await syncedWithEpicenter({ path: location });
		synced = error === null ? data : undefined;
	}

	onMount(() => {
		void read();
		return on(window, 'focus', () => void read());
	});

	return {
		get location() {
			return location;
		},
		get synced() {
			return synced;
		},
		get request() {
			return request;
		},
		async syncWithEpicenter() {
			request = undefined;
			if (location === undefined) await read();
			if (location === undefined) {
				request = syncRequestOutcome({
					message: "This window's folder could not be read.",
				});
				return;
			}
			const { error } = await syncWithEpicenter({
				path: location,
				contract: CONTRACT_URL,
			});
			request = syncRequestOutcome(error);
		},
		async chooseFolder() {
			// On success the shell opens the new folder's window and closes this
			// one once its saves land.
			await invoke<boolean>('choose_folder').catch((cause: unknown) => {
				toast.error('Could not use that folder', {
					description: String(cause),
				});
			});
		},
	};
}
