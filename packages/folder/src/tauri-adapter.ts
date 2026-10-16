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
 * This module exports the opener alone. `tauri.ts` is the public entry; the
 * automatic entry loads this module directly. The engine is a chunk loaded
 * only once the shell grants a folder.
 *
 * `openDataFolder` opens a registered folder the same way, with the schema
 * in its own `epicenter.json`, until the shell issues opaque grants for
 * folders a person picks.
 *
 * Outside the desktop app these openers refuse. Inside it, a missing plugin, a
 * window without permission, or an unknown folder is returned as the refusal
 * it is. Nothing here opens browser storage.
 */

import { isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type {
	OpenDataFolder,
	OpenDataFolderOptions,
	OpenFolder,
} from './contract.js';
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

/**
 * Open the folder the shell registered under `id`. Refusals are returned, not
 * thrown: not running in the shell, a missing ID, a folder this window may
 * not use.
 */
export const openFolder: OpenFolder = async ({ definition, id }) => {
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(definition);
	if (definitionError !== null)
		return OpenFolderError.InvalidDefinition(definitionError);
	const { data: granted, error } = await grant(id);
	if (error !== null) return Err(error);
	const { openGrantedFolder } = await import('./tauri-directory.js');
	return openGrantedFolder<typeof definition>({
		schema: prepared,
		id,
		granted,
	});
};

/**
 * Open the folder the shell registered under `id` with the schema in its own
 * `epicenter.json`, which the handle never writes. Refused as `openFolder`
 * is, with `InvalidDeclaration` for an `epicenter.json` that cannot be
 * used, and with `ShapeMismatch` for one that does not contain the `lens`.
 * Opening creates no repository; the first commit does.
 */
export const openDataFolder: OpenDataFolder = async <
	const TLens extends FolderDefinition = FolderDefinition,
>({
	id,
	lens,
}: OpenDataFolderOptions<TLens>) => {
	let shape: FolderDefinition | undefined;
	if (lens !== undefined) {
		const { data: prepared, error: lensError } = prepareFolderDefinition(lens);
		if (lensError !== null) return OpenFolderError.InvalidDefinition(lensError);
		shape = prepared;
	}
	const { data: granted, error } = await grant(id);
	if (error !== null) return Err(error);
	const { openGrantedFolder } = await import('./tauri-directory.js');
	return openGrantedFolder<TLens, FolderDefinition>({
		schema: 'declared',
		lens: shape,
		id,
		granted,
	});
};
