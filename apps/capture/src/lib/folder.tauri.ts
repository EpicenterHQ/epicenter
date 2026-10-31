/**
 * `#platform/folder` in Capture's desktop window: the folder Capture owns
 * and its machine-local settings (decisions 81 and 82). The shell gave this
 * window two roots (`appFolders()`): the configuration directory, opened
 * here as `appConfig`'s client, and the folder, which `settings.md` records
 * (`rememberFolder`). Whether Epicenter syncs the folder and "Sync with
 * Epicenter" go through the folder plugin; choosing a folder is
 * `choose_folder` in `epicenter-standalone`, which admits it and moves the
 * window there.
 */
import { APPS } from '@epicenter/constants/apps';
import {
	appConfig,
	appFolders,
	openDevice,
	rememberFolder,
	syncedWithEpicenter,
	syncWithEpicenter,
} from '@epicenter/folder/tauri';
import { invoke } from '@tauri-apps/api/core';
import type { DesktopFolder, FolderRequest } from './platform.js';

/** Where Capture's web app publishes its contract (`static/contract.json`). */
const CONTRACT_URL = `${APPS.CAPTURE.url}/contract.json`;

const folders = appFolders();

/** Capture's machine-local settings, never synced. */
const config =
	folders === null ? null : openDevice(appConfig, { path: folders.config });

const path = folders?.folder ?? null;

const notOpened = (message: string): FolderRequest => ({ ok: false, message });

export const folder: DesktopFolder | null =
	folders === null
		? null
		: {
				path,
				problem: folders.problem,
				places: folders.places,
				remembered:
					config === null || path === null
						? Promise.resolve({ ok: true })
						: rememberFolder(config, path).then(({ error }) =>
								error === null ? { ok: true } : notOpened(error.message),
							),
				async synced() {
					if (path === null) return 'unknown';
					const { data, error } = await syncedWithEpicenter({ path });
					if (error !== null) return 'unknown';
					return data ? 'synced' : 'not-synced';
				},
				async syncWithEpicenter() {
					if (path === null) return notOpened('Choose a folder first.');
					const { error } = await syncWithEpicenter({
						path,
						contract: CONTRACT_URL,
					});
					return error === null ? { ok: true } : notOpened(error.message);
				},
				choose: (place) =>
					invoke<boolean>('choose_folder', { place }).then(
						() => ({ ok: true }) as const,
						(cause: unknown) => notOpened(String(cause)),
					),
			};
