/**
 * `@epicenter/folder/browser`: this origin's default local folder, and
 * nothing else.
 *
 * `openFolder({ tables })` opens the one local folder of this web origin, kept
 * in IndexedDB under a fixed internal key (ADR-0636). A build that imports
 * this entry, or aliases the bare specifier to it, carries no desktop engine.
 * Inside the desktop app the opener refuses: that page's folders are
 * directories the shell owns.
 *
 * Importing this module opens nothing.
 */
import { isTauri } from '@tauri-apps/api/core';
import type { TSchema as Schema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { OpenFolderError } from './errors.js';
import type { DefaultFolderOptions, Folder } from './folder.js';
import { openLocalFolder } from './local-folder.js';

export * from './contract.js';

/**
 * Open this origin's default local folder. Refusals are returned, not
 * thrown: a page inside the desktop app, a table that cannot be one
 * top-level directory, missing IndexedDB, or folders the former OPFS opener
 * left in this browser (`LegacyDataPresent`), which stay untouched.
 */
export async function openFolder<const TTables extends Record<string, Schema>>(
	options: DefaultFolderOptions<TTables>,
): Promise<Result<Folder<TTables>, OpenFolderError>> {
	if (isTauri()) return OpenFolderError.InsideTauri();
	if ('directory' in options) return OpenFolderError.NotTauri();
	return openLocalFolder(options);
}
