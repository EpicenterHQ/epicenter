/**
 * `@epicenter/folder`: a file-authoritative folder, opened wherever the page
 * is running.
 *
 * A folder's current files are its saved data: Markdown rows and any other
 * file. In a browser tab they are files in the origin private file system. In the desktop app they are files in a directory the shell grants
 * the page.
 *
 * `openFolder` and `openDataFolder` decide which when they are called, not
 * when this module is imported, and load only the adapter they chose. Importing this module opens
 * nothing. To build for one environment, import `@epicenter/folder/browser`
 * or `@epicenter/folder/tauri`, or alias this exact specifier to one of them.
 */
import { isTauri } from '@tauri-apps/api/core';
import type { OpenDataFolder, OpenFolder } from './contract.js';

export * from './contract.js';

/**
 * Open a folder in the desktop app when the page runs there, and in this
 * browser's storage otherwise. A desktop page whose folder cannot be opened
 * gets that refusal; it is never given browser storage instead.
 */
export const openFolder: OpenFolder = async (options) =>
	// The adapters are loaded by themselves, not through the explicit entries:
	// those re-export the whole contract, which would tie each adapter's chunk
	// to everything the other one shares with it.
	isTauri()
		? (await import('./tauri-adapter.js')).openFolder(options)
		: (await import('./browser-adapter.js')).openFolder(options);

/**
 * Open an existing folder with the schema in its own `epicenter.json`: one
 * the desktop shell registered when the page runs there, and one in this
 * browser's storage otherwise. The handle never writes `epicenter.json`.
 */
export const openDataFolder: OpenDataFolder = async (options) =>
	isTauri()
		? (await import('./tauri-adapter.js')).openDataFolder(options)
		: (await import('./browser-adapter.js')).openDataFolder(options);
