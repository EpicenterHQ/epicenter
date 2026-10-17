/**
 * The desktop opener: a folder whose directory the desktop shell grants.
 *
 * The shell registers each folder's directory under an ID for the windows
 * that may edit it; several windows of one folder each open their own engine
 * over the same directory, and the shell checks and publishes every save.
 * This opener asks the shell for that directory (`grant_directory`) and opens
 * it with the folder engine (`tauri-directory.ts`): files are read and
 * changed through the shell, which checks every path, and history is the
 * `epicenter` CLI's, which the shell runs. The page names the folder's ID
 * and nothing else; the root is the shell's, and `credentials` and
 * `browser` options do not apply here.
 *
 * The shell opens an installed app's window with the folder it hands it as
 * `?folder=<scope>` (`open_installed_app`): the app's own folder, named by
 * the app's id, or any other folder (ADR-0560). An app opener opens that
 * folder, or the app's own when the window was handed none.
 *
 * This module exports the opener alone. `tauri.ts` is the public entry; the
 * automatic entry loads this module directly. The engine is a chunk loaded
 * only once the shell grants a folder.
 *
 * Outside the desktop app the opener refuses. Inside it, a missing plugin, a
 * window without permission, or an unknown folder is returned as the refusal
 * it is. Nothing here opens browser storage.
 */

import { isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { OpenFolder, OpenFolderOptions } from './contract.js';
import type { FolderDefinition } from './definition.js';
import { OpenFolderError } from './errors.js';
import {
	commands,
	type GrantError,
	type Granted,
} from './native/bindings.gen.js';
import { opening } from './opening.js';

/** What a refused grant tells the page. */
function grantRefusal(refusal: GrantError) {
	switch (refusal.name) {
		case 'UnknownScope':
			return OpenFolderError.UnknownScope(refusal);
		case 'WindowNotPermitted':
			return OpenFolderError.WindowNotPermitted(refusal);
		case 'Missing':
			return OpenFolderError.Missing(refusal);
		case 'Unavailable':
			return OpenFolderError.Unavailable({ cause: refusal.message });
		case 'ShuttingDown':
			return OpenFolderError.ShuttingDown();
		default:
			return OpenFolderError.Unavailable({ cause: refusal });
	}
}

/** The directory the shell registered under `id`, granted to this window. */
async function grant(id: string): Promise<Result<Granted, OpenFolderError>> {
	if (!isTauri()) return OpenFolderError.NotTauri();
	if (typeof id !== 'string' || id.trim() === '')
		return OpenFolderError.InvalidId({ id: String(id) });
	let granted: Awaited<ReturnType<typeof commands.grantDirectory>>;
	try {
		granted = await commands.grantDirectory(id);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	const { data: directory, error } = granted;
	if (error !== null) {
		// Tauri also rejects with strings for missing commands or permissions,
		// which the generated bindings pass on as the refusal type; only an
		// object with a name is the shell's own refusal.
		if (typeof error !== 'object' || error === null || !('name' in error))
			return OpenFolderError.Unavailable({ cause: error });
		return grantRefusal(error);
	}
	return Ok(directory);
}

/** The scope the shell handed this window as `?folder=`, if any. */
function handedScope(): string | undefined {
	const handed = new URLSearchParams(globalThis.location?.search).get('folder');
	return handed || undefined;
}

/**
 * Open a folder the shell registered: for `app`, the folder the shell
 * handed this window, or the app's own when it was handed none; for `id`,
 * that folder. Refusals are returned, not thrown: not running in the shell,
 * a missing ID, a folder this window may not use, an `epicenter.json` that
 * cannot be used, or one that does not contain the definition. Opening
 * creates no repository; the first commit does.
 */
export const openFolder: OpenFolder = async <
	const TDefinition extends FolderDefinition = FolderDefinition,
>(
	options: OpenFolderOptions<TDefinition>,
) => {
	const id =
		options.app === undefined ? options.id : (handedScope() ?? options.app);
	const { data: target, error: definitionError } = opening(
		id,
		options.app,
		options.definition,
	);
	if (definitionError !== null) return Err(definitionError);
	const { data: granted, error } = await grant(id);
	if (error !== null) return Err(error);
	const { openGrantedFolder } = await import('./tauri-directory.js');
	return openGrantedFolder<TDefinition>({ opening: target, granted });
};
