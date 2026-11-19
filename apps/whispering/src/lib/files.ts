/**
 * Files in the app's local data directory, through `tauri-plugin-fs`. A file
 * is written whole: to `<path>.tmp` beside it, then renamed over `<path>`, so
 * a crash mid-write leaves the old file whole.
 */
import { BaseDirectory, rename, writeTextFile } from '@tauri-apps/plugin-fs';

/** The option that reads a relative path in the app's local data directory. */
export const appData = { baseDir: BaseDirectory.AppLocalData };

/** Replace the file at `path` with `text`, through a temporary file beside it. */
export async function writeWhole(path: string, text: string) {
	const temporary = `${path}.tmp`;
	await writeTextFile(temporary, text, appData);
	await rename(temporary, path, {
		oldPathBaseDir: BaseDirectory.AppLocalData,
		newPathBaseDir: BaseDirectory.AppLocalData,
	});
}
