/**
 * `@epicenter/folder`: a file-authoritative folder, opened wherever the page
 * is running.
 *
 * A folder's current files are its saved data: Markdown rows and any other
 * file. In a browser tab they are files in the origin private file system.
 * In the desktop app they are files in a directory the shell grants the
 * page, and an app opens the folder the shell handed its window.
 *
 * `openFolder` decides which when it is called, not when this module is
 * imported, and loads only the adapter it chose. Importing this module opens
 * nothing. To build for one environment, import `@epicenter/folder/browser`
 * or `@epicenter/folder/tauri`, or alias this exact specifier to one of them.
 */
import { isTauri } from '@tauri-apps/api/core';
import type {
	FolderDefinition,
	OpenFolder,
	OpenFolderOptions,
} from './contract.js';

export * from './contract.js';

/**
 * Open a folder in the desktop app when the page runs there, and in this
 * browser's storage otherwise. On the desktop an app opens the folder the
 * shell handed its window; in a browser, its own. A desktop page
 * whose folder cannot be opened gets that refusal; it is never given browser
 * storage instead.
 */
export const openFolder: OpenFolder = async <
	const TDefinition extends FolderDefinition = FolderDefinition,
>(
	options: OpenFolderOptions<TDefinition>,
) =>
	// The adapters are loaded by themselves, not through the explicit entries:
	// those re-export the whole contract, which would tie each adapter's chunk
	// to everything the other one shares with it.
	isTauri()
		? (await import('./tauri-adapter.js')).openAnyFolder(options)
		: (await import('./browser-adapter.js')).openAnyFolder(options);
