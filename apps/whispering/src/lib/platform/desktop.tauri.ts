/**
 * `#platform/desktop` in Whispering's desktop app: its root (Whispering over
 * the folder the person chose), its header and extra settings, and its
 * folder, which Whispering owns (decisions 81 and 82). "Sync with
 * Epicenter" and whether Epicenter syncs the folder go through
 * `@epicenter/folder/tauri`; choosing it through `epicenter-standalone`,
 * which keeps the choice in the app's `settings.md` (`appConfig`).
 */
import { APPS } from '@epicenter/constants/apps';
import {
	syncedWithEpicenter,
	syncWithEpicenter,
} from '@epicenter/folder/tauri';
import { Err, Ok } from 'wellcrafted/result';
import DesktopRoot from '../../routes/components/desktop/DesktopRoot.svelte';
import DesktopSettings from '../../routes/components/desktop/DesktopSettings.svelte';
import FolderStatus from '../../routes/components/desktop/FolderStatus.svelte';
import { chooseFolder, folderPath } from './shell.tauri.js';
import type { DesktopFolder, DesktopShell } from './types.js';

/**
 * Where Whispering's contract is published (`static/contract.json` on its
 * web app). Deployment, not data, so a constant here and not in the
 * contract (decision 82).
 */
export const CONTRACT_URL = `${APPS.WHISPERING.url}/contract.json`;

const folder: DesktopFolder = {
	path: folderPath,
	async synced(path) {
		const { data, error } = await syncedWithEpicenter({ path });
		if (error !== null) return 'unknown';
		return data ? 'synced' : 'not-synced';
	},
	async syncWithEpicenter(path) {
		const { error } = await syncWithEpicenter({ path, contract: CONTRACT_URL });
		return error === null ? Ok(undefined) : Err(error.message);
	},
	choose: chooseFolder,
};

export const desktop: DesktopShell | null = {
	Root: DesktopRoot,
	Header: FolderStatus,
	Settings: DesktopSettings,
	folder,
};
