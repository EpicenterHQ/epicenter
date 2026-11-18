/**
 * Whispering's capabilities, opened once for the page's life (ADR-0766).
 * Every page, component and module imports what it uses from here; product
 * state (Whispering and its library) is the app's own (`WhisperingApp`).
 *
 * - `folder` is Whispering's folder over one `Files` (ADR-0894): the data
 *   folder on the desktop (`data/` in the app's local data directory unless
 *   the person moved it, `folderPath`), and the Origin Private File System's
 *   `data/` in a browser. It holds the notes, the audio and `settings.md`.
 * - `query` is the page's one `QueryClient` over it (`folder-query.ts`):
 *   the notes and audio as one query and `settings.md` as another, both
 *   read before the app renders and whenever the window regains focus, and
 *   every write as a mutation. Components read `settings.md` through its
 *   query; the connections and the shortcut through `query.settings`.
 * - `ai` is every model this page reaches (ADR-0757), in the order the
 *   model picker lists them: the person's connections (`settings.md`, each
 *   key a secret on this computer), Ollama and LM Studio on this computer,
 *   then, on the desktop, transcription in this app's process (`speech`).
 *   Nothing sends a request until the person asks.
 * - `speech` is transcription in this app's process, null in a browser.
 * - `recorder` records from the microphone into the folder's
 *   `recordings/`: the shell's in a Tauri window, the page's own in a
 *   browser.
 * - `shortcut` is the global shortcut, null in a browser.
 */
import { customEndpoints, localServers, openAi } from '@epicenter/ai';
import { type AudioFiles, recorder as microphone } from '@epicenter/recorder';
import { localSpeech } from '@epicenter/transcription';
import { focusManager } from '@tanstack/query-core';
import { isTauri } from '@tauri-apps/api/core';
import { folderFiles, zipOf } from './export.js';
import type { Files } from './files/files.js';
import { opfsFiles } from './files/opfs.js';
import { tauriFiles } from './files/tauri.js';
import { openFolder } from './folder.js';
import { createFolderQuery } from './folder-query.js';
import { createMicrophoneDevice } from './microphone.js';
import { reactive } from './reactive.js';
import { openShortcut } from './shortcut.js';
import { folderPath, requestFetch, secrets } from './this-computer.js';

/** The default folder's name, in the app's local data directory on the desktop and in the Origin Private File System in a browser. */
const DATA = 'data';

/** The desktop folder's absolute path once it is known, which the first read of the folder settles. */
let desktopFolder: string | null = null;

/** Where the desktop folder is: the one the person picked, else the default. */
async function desktopFolderPath(): Promise<string> {
	const picked = folderPath.get();
	if (picked !== null) {
		desktopFolder = picked;
		return picked;
	}
	const { appLocalDataDir, join } = await import('@tauri-apps/api/path');
	desktopFolder = await join(await appLocalDataDir(), DATA);
	return desktopFolder;
}

const files: Files = isTauri()
	? tauriFiles(desktopFolderPath)
	: opfsFiles(DATA);

/** The folder as the recorder writes audio into it, where the shell may write it itself. */
const audioFiles: AudioFiles = {
	get location() {
		return desktopFolder;
	},
	read: (path) => files.read(path),
	write: (path, bytes) => files.write(path, bytes),
};

export const folder = openFolder(files);
export const query = createFolderQuery(folder);

// The folder is read again when the window regains focus. A desktop window
// keeps its page visible while another app is in front, so the window's own
// focus decides, not the page's visibility.
focusManager.setEventListener((setFocused) => {
	const focused = () => setFocused(true);
	const blurred = () => setFocused(false);
	window.addEventListener('focus', focused);
	window.addEventListener('blur', blurred);
	return () => {
		window.removeEventListener('focus', focused);
		window.removeEventListener('blur', blurred);
	};
});

/** Where the folder is: its absolute path on the desktop, null in a browser. */
export const folderLocation = () => desktopFolder;

/** The folder as one zip file, for a browser's export; why not, as text. */
export async function exportFolder() {
	const read = await folderFiles(files);
	if (read.error !== null) return read.error.message;
	return zipOf('whispering', read.data);
}

export const speech = localSpeech();
export const ai = reactive(
	openAi([
		customEndpoints({
			store: query.settings.connections,
			keys: {
				get: (id) => secrets.get(`connection.${id}`),
				set: (id, key) => secrets.set(`connection.${id}`, key),
			},
			fetch: requestFetch,
		}),
		localServers({ fetch: requestFetch }),
		speech,
	]),
);
export const recorder = createMicrophoneDevice({
	files: audioFiles,
	recorder: microphone,
});
const held = openShortcut(query.settings.shortcut);
export const shortcut = held && reactive(held);
/** Start holding the global shortcut, once the folder was first read. */
export const holdShortcut = () => held?.holdNow();
/** Where a connection's key is kept, as Settings tells the person. */
export const keysKept = secrets.where;
