/**
 * `@epicenter/folder`: the one `Folder`, opened wherever the page is running.
 *
 * `openFolder({ tables })` opens the runtime's own folder. In a browser tab
 * it is this origin's default local folder in IndexedDB. In the desktop app
 * it is the directory the shell bound to this window before the window
 * existed. A desktop page is never given browser storage, and neither names
 * a directory: a Bun tool opens a path through `@epicenter/folder/bun`.
 *
 * `openFolder` decides which when it is called, not when this module is
 * imported, and loads only the engine it chose. Importing this module opens
 * nothing. To build for one environment, import `@epicenter/folder/browser`
 * or `@epicenter/folder/tauri`, or alias this exact specifier to one of them.
 */
import { isTauri } from '@tauri-apps/api/core';
import { OpenFolderError } from './errors.js';
import type { OpenFolder } from './folder.js';

export * from './contract.js';

/** Open the browser origin's local folder, or this desktop window's folder. */
export const openFolder: OpenFolder = async (options) => {
	// The engines are loaded by themselves, not through the explicit entries:
	// those re-export the whole contract, which would tie each engine's chunk
	// to everything the other one shares with it.
	if (isTauri()) {
		const { openTauriFolder } = await import('./native/tauri.js');
		return openTauriFolder(options);
	}
	if (options.directory !== undefined) return OpenFolderError.NotTauri();
	const { openLocalFolder } = await import('./local-folder.js');
	return openLocalFolder({ tables: options.tables });
};
