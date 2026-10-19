/**
 * `@epicenter/folder`: the one `Folder`, opened wherever the page is running.
 *
 * In a browser tab, `openFolder({ tables })` opens this origin's default
 * local folder in IndexedDB. In the desktop app, the same call opens the
 * folder assigned to this window. `directory` selects another folder the
 * shell registered for the window. A desktop page is never given browser
 * storage, and a browser tab has no directory to open.
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

/**
 * Open the runtime's default folder, or a directory the desktop shell
 * registered for this window.
 */
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
