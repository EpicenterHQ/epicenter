/**
 * `@epicenter/folder`: a file-authoritative folder, opened wherever the page
 * is running.
 *
 * A folder's current files are its saved data: Markdown rows and any other
 * file. In a browser tab the default local folder uses IndexedDB; older
 * named folders use the origin private file system until migration.
 * In the desktop app they are files in a directory the shell grants the
 * page, and an app opens the folder the shell handed its window.
 *
 * `openFolder` decides which when it is called, not when this module is
 * imported, and loads only the adapter it chose. Importing this module opens
 * nothing. To build for one environment, import `@epicenter/folder/browser`
 * or `@epicenter/folder/tauri`, or alias this exact specifier to one of them.
 */
import { isTauri } from '@tauri-apps/api/core';
import type { AnyFolderOptions, OpenFolder } from './contract.js';

export * from './contract.js';

/**
 * Open a folder in the desktop app when the page runs there, and in this
 * browser's storage otherwise. `openFolder({ tables })` opens the browser
 * origin's default local folder. The other forms are the temporary migration
 * boundary of `contract.ts`: on the desktop an app opens the folder the
 * shell handed its window; in a browser, its own. A desktop page
 * whose folder cannot be opened gets that refusal; it is never given browser
 * storage instead.
 */
export const openFolder = (async (options: AnyFolderOptions) =>
	// The adapters are loaded by themselves, not through the explicit entries:
	// those re-export the whole contract, which would tie each adapter's chunk
	// to everything the other one shares with it.
	isTauri()
		? (await import('./tauri-adapter.js')).openAnyFolder(options as never)
		: (await import('./browser-adapter.js')).openAnyFolder(
				options as never,
			)) as unknown as OpenFolder;
