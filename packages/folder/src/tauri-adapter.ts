/**
 * The desktop opener: a folder whose directory the desktop shell grants.
 *
 * The shell registers each folder's directory under an ID for the windows
 * that may edit it; several windows of one folder each open their own engine
 * over the same directory, and the shell checks and publishes every save.
 * This opener asks the shell for that directory (`grant_directory`) and opens
 * it with the folder engine (`tauri-directory.ts`): files are read and
 * changed through the shell, which checks every path, and history is the
 * system `git`, which the shell runs. The page names the
 * folder's ID and nothing else; the root and the fallback author are the
 * shell's, and `browser` options do not apply here.
 *
 * This module exports the opener alone. `tauri.ts` is the public entry; the
 * automatic entry loads this module directly. The engine is a chunk loaded
 * only once the shell grants a folder.
 *
 * `openDataFolder` opens a registered folder the same way, with the schema
 * in its own `epicenter.json`, until the shell issues opaque grants for
 * folders a person picks.
 *
 * Outside the desktop app these openers refuse. Inside it, a missing plugin, a
 * window without permission, an unknown folder, or a folder another process
 * holds is returned as the refusal it is. Nothing here opens browser storage.
 */

import { isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { OpenDataFolder, OpenFolder } from './contract.js';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import { OpenFolderError } from './errors.js';
import {
	commands,
	type GrantError,
	type Granted,
} from './native/bindings.gen.js';

/** What a refused grant tells the page. */
function grantRefusal(refusal: GrantError) {
	switch (refusal.name) {
		case 'UnknownScope':
			return OpenFolderError.UnknownScope(refusal);
		case 'WindowNotPermitted':
			return OpenFolderError.WindowNotPermitted(refusal);
		case 'Busy':
			return OpenFolderError.Busy(refusal);
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

/**
 * Open the folder the shell registered under `id`. Refusals are returned, not
 * thrown: not running in the shell, a missing ID, a folder this window may
 * not use, a folder another process holds.
 */
export const openFolder: OpenFolder = async ({
	definition,
	id,
	credentials,
}) => {
	const { error: definitionError } = prepareFolderDefinition(definition);
	if (definitionError !== null)
		return OpenFolderError.InvalidDefinition(definitionError);
	const { data: granted, error } = await grant(id);
	if (error !== null) return Err(error);
	const { openGrantedFolder } = await import('./tauri-directory.js');
	return openGrantedFolder({ definition, id, granted, credentials });
};

/**
 * Open the folder the shell registered under `id` with the schema in its own
 * `epicenter.json`, which the handle never writes. Refused as `openFolder`
 * is, and with `InvalidDeclaration` for an `epicenter.json` that cannot be
 * used. Opening creates no repository; the first commit does.
 */
export const openDataFolder: OpenDataFolder = async ({ id, credentials }) => {
	const { data: granted, error } = await grant(id);
	if (error !== null) return Err(error);
	const { openGrantedFolder } = await import('./tauri-directory.js');
	return openGrantedFolder<FolderDefinition>({
		definition: 'declared',
		id,
		granted,
		credentials,
	});
};
