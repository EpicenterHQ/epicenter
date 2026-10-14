/**
 * The desktop opener: a folder whose directory the desktop shell grants.
 *
 * The shell registers each folder's directory under an ID for one window.
 * This opener asks the shell for that directory (`grant_directory`) and opens
 * it with the folder engine (`tauri-directory.ts`): files are read through
 * Tauri's fs plugin and changed through the shell, which checks every path,
 * and history is the system `git`, which the shell runs. The page names the
 * folder's ID and nothing else; the root and the fallback author are the
 * shell's, and `browser` options do not apply here.
 *
 * This module exports the opener alone. `tauri.ts` is the public entry; the
 * automatic entry loads this module directly. The engine is a chunk loaded
 * only once the shell grants a folder.
 *
 * Outside the desktop app this opener refuses. Inside it, a missing plugin, a
 * window without permission, an unknown folder, or a folder another process
 * holds is returned as the refusal it is. Nothing here opens browser storage.
 */

import { isTauri } from '@tauri-apps/api/core';
import type { OpenFolder } from './contract.js';
import { prepareFolderDefinition } from './definition.js';
import { OpenFolderError } from './errors.js';
import { commands, type GrantError } from './native/bindings.gen.js';

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
	const { openGrantedFolder } = await import('./tauri-directory.js');
	return openGrantedFolder({ definition, id, granted: directory, credentials });
};
