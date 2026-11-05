/**
 * `@epicenter/local` in a desktop build (the `tauri` leaf): this computer's
 * settings are files at the top of the app's AppData root, which the shell
 * names at startup (`app_data_dir()`, never synced). The shell is their only
 * writer: a page asks it to replace a file (`put_folder_file` expecting
 * `any`), and its watcher of the root tells every window, this one included,
 * which files changed. The page names the root, never a path.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createSettings } from './settings.js';

export {
	type Settings,
	SettingsError,
	type SettingsFile,
	SettingsNotOpen,
	type SettingsState,
} from './settings.js';

const ROOT = 'AppData';

/** The shell's change report for a root it watches. */
type FolderEvent = { root: string; paths: string[] | null };

/** Whether the shell answered that no file is at the path. */
const isNotFound = (value: unknown) =>
	typeof value === 'object' &&
	value !== null &&
	'name' in value &&
	value.name === 'NotFound';

const decoder = new TextDecoder('utf-8', { fatal: true });

/** This computer's settings for this app: its AppData root, through the shell. */
export const settings = createSettings({
	async watch(changed) {
		// Listen before the root opens, so nothing the shell sends is missed.
		const stop = await listen<FolderEvent>('folder-changed', ({ payload }) => {
			if (payload.root !== ROOT) return;
			changed(payload.paths ?? 'all');
		});
		try {
			await invoke('plugin:epicenter-folder|open_root', { root: ROOT });
		} catch (cause) {
			stop();
			throw cause;
		}
		return stop;
	},
	async read(name) {
		let response: Uint8Array;
		try {
			response = new Uint8Array(
				await invoke<ArrayBuffer>('plugin:epicenter-folder|read_folder_file', {
					path: name,
					root: ROOT,
				}),
			);
		} catch (cause) {
			if (isNotFound(cause)) return null;
			throw cause;
		}
		// The shell answers the file's stamp, a NUL, then its bytes.
		return decoder.decode(response.subarray(response.indexOf(0) + 1));
	},
	async write(name, text) {
		await invoke(
			'plugin:epicenter-folder|put_folder_file',
			text === null ? new Uint8Array() : new TextEncoder().encode(text),
			{
				headers: {
					path: encodeURIComponent(name),
					root: ROOT,
					remove: String(text === null),
					expected: 'any',
				},
			},
		);
	},
});
