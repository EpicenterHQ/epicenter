/**
 * Where Whispering keeps its files, chosen once: the app's local data
 * directory in the desktop app, the Origin Private File System in a browser.
 * The data modules (`#lib/data/*`) import this and never ask which it is.
 *
 * ```txt
 * settings.json
 * recordings/<id>.md      note: durationMs, then the transcript
 * recordings/<id>.webm    audio (.m4a from Safari)
 * ```
 */
import { isTauri } from '@tauri-apps/api/core';
import { opfsFiles } from './opfs';
import { tauriFiles } from './tauri';

export type { Files, FilesError } from './files';

export const files = isTauri() ? tauriFiles() : opfsFiles();
