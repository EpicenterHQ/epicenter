/**
 * `@epicenter/local` in a desktop build (the `tauri` leaf): each file sits
 * at the top of the app's AppData root, which the shell names at startup
 * (`app_data_dir()`, never synced), and every read and write is one command
 * of the shell's folder plugin over that root by name, as the page names
 * every root. The shell checks the path, stages the write, and lands it only
 * over the version it expects; its watcher reports a change made by hand or
 * by another window.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Ok, type Result } from 'wellcrafted/result';
import {
	createListeners,
	LocalFileError,
	type OpenLocalFile,
} from './local-file.js';

export {
	type LocalFile,
	LocalFileError,
	type LocalText,
} from './local-file.js';

const ROOT = 'AppData';

/** The shell's change report for a root it watches. */
type FolderEvent = { root: string; paths: string[] | null };

let opening: Promise<Result<null, LocalFileError>> | undefined;

/** Ask the shell to open AppData, once; a refusal is asked again next time. */
function openRoot() {
	opening ??= invoke('plugin:epicenter-folder|open_root', { root: ROOT }).then(
		() => Ok(null),
		(cause: unknown) => {
			opening = undefined;
			return LocalFileError.Unavailable({ cause });
		},
	);
	return opening;
}

const own = createListeners();

/** The sha256 of `bytes` in hex: the version the shell checks a write against. */
async function versionOf(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** Whether the shell answered that no file is at the path. */
const isNotFound = (value: unknown) =>
	typeof value === 'object' &&
	value !== null &&
	'name' in value &&
	value.name === 'NotFound';

/** The file `name` at the top of this app's AppData root. */
export const localFile: OpenLocalFile = (name) => ({
	async read() {
		const opened = await openRoot();
		if (opened.error !== null) return opened;
		let response: Uint8Array;
		try {
			response = new Uint8Array(
				await invoke<ArrayBuffer>('plugin:epicenter-folder|read_folder_file', {
					path: name,
					root: ROOT,
				}),
			);
		} catch (cause) {
			if (isNotFound(cause)) return Ok(null);
			return LocalFileError.Unavailable({ cause });
		}
		// The shell answers the file's stamp, a NUL, then its bytes.
		const bytes = response.subarray(response.indexOf(0) + 1);
		try {
			return Ok({
				text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
				version: await versionOf(bytes),
			});
		} catch (cause) {
			return LocalFileError.Unavailable({ cause });
		}
	},
	async write(text, over) {
		const opened = await openRoot();
		if (opened.error !== null) return opened;
		const bytes =
			text === null ? new Uint8Array() : new TextEncoder().encode(text);
		try {
			const outcome = await invoke<'landed' | 'stale'>(
				'plugin:epicenter-folder|put_folder_file',
				bytes,
				{
					headers: {
						path: encodeURIComponent(name),
						root: ROOT,
						remove: String(text === null),
						expected: over === 'absent' ? 'absent' : `sha256:${over}`,
					},
				},
			);
			if (outcome === 'stale') return Ok(outcome);
			own.emit(name);
			return Ok({
				version: text === null ? 'absent' : await versionOf(bytes),
			});
		} catch (cause) {
			return LocalFileError.Unavailable({ cause });
		}
	},
	subscribe(listener) {
		const stopOwn = own.add(name, listener);
		let stopped = false;
		let unlisten: (() => void) | undefined;
		// The shell watches a root once a page opened it.
		void openRoot();
		void listen<FolderEvent>('folder-changed', ({ payload }) => {
			if (payload.root !== ROOT) return;
			if (payload.paths === null || payload.paths.includes(name)) listener();
		}).then(
			(stop) => {
				if (stopped) stop();
				else unlisten = stop;
			},
			() => {},
		);
		return () => {
			stopped = true;
			stopOwn();
			unlisten?.();
		};
	},
});
