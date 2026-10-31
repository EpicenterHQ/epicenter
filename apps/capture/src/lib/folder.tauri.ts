/**
 * `#platform/folder` in Capture's desktop window: the folder Capture owns
 * (decisions 81 and 82), as the page may act on it. Its path comes from the
 * shell (`folder_path` in `epicenter-standalone`, which bound it to this
 * window from `folder` in Capture's `settings.md`); whether Epicenter syncs
 * it and "Sync with Epicenter" go through the folder plugin
 * (`@epicenter/folder/tauri`); "Choose folder…" is `choose_folder`.
 */
import { APPS } from '@epicenter/constants/apps';
import {
	syncedWithEpicenter,
	syncWithEpicenter,
} from '@epicenter/folder/tauri';
import { invoke } from '@tauri-apps/api/core';
import type { DesktopFolder } from './platform.js';

/** Where Capture's web app publishes its contract (`static/contract.json`). */
const CONTRACT_URL = `${APPS.CAPTURE.url}/contract.json`;

/** The window's folder, as an absolute path; asked once, since a move replaces the window. */
let path: Promise<string> | undefined;
const folderPath = () => {
	path ??= invoke<string>('folder_path');
	return path;
};

export const folder: DesktopFolder | null = {
	async synced() {
		const answer = await folderPath().then(
			(path) => syncedWithEpicenter({ path }),
			() => null,
		);
		if (answer === null || answer.error !== null) return 'unknown';
		return answer.data ? 'synced' : 'not-synced';
	},
	async syncWithEpicenter() {
		const found = await folderPath().then(
			(path) => ({ path }),
			(cause: unknown) => ({ message: String(cause) }),
		);
		if (!('path' in found)) return { ok: false, message: found.message };
		const { error } = await syncWithEpicenter({
			path: found.path,
			contract: CONTRACT_URL,
		});
		return error === null
			? { ok: true }
			: { ok: false, message: error.message };
	},
	// A native picker, then a new window bound to the folder picked.
	chooseFolder: () =>
		invoke<boolean>('choose_folder').then(
			() => ({ ok: true }) as const,
			(cause: unknown) => ({ ok: false, message: String(cause) }) as const,
		),
};
