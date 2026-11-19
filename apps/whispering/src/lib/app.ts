/**
 * Where Whispering keeps its files, chosen once: the app's local data
 * directory in the desktop app, the Origin Private File System in a browser.
 * Each data module is made over that one `Files` here, and nothing else
 * chooses.
 *
 * ```txt
 * settings.json
 * recordings/<id>.md      note: durationMs, then the transcript
 * recordings/<id>.webm    audio (.m4a from Safari)
 * ```
 */
import { isTauri } from '@tauri-apps/api/core';
import { createRecordings } from './data/recordings';
import { createSettings } from './data/settings';
import { opfsFiles } from './files/opfs';
import { tauriFiles } from './files/tauri';

export const files = isTauri() ? tauriFiles() : opfsFiles();

export const recordings = createRecordings(files);
export const settingsFile = createSettings(files);
