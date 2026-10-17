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
 * The shell opens each installed app's window on one folder and records,
 * for that window, which app it runs and which folder it was handed
 * (`window_folder`): the app's own folder, named by the app's id, or any
 * other folder a person chose "Open in" on (ADR-0560). An app opener asks
 * the shell for it, so neither the page's URL nor its navigation decides
 * the folder, and a page cannot open another app's folder as that app.
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
import type { Definition } from './definition.js';
import { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
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

/**
 * The folder the shell handed this window, which must be running `app`.
 * Refused when the window runs another app, or none.
 */
async function handedFolder(
	app: string,
): Promise<Result<string, OpenFolderError>> {
	let handed: Awaited<ReturnType<typeof commands.windowFolder>>;
	try {
		handed = await commands.windowFolder();
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	if (handed?.app !== app)
		return OpenFolderError.AppMismatch({
			app,
			windowApp: handed?.app ?? null,
		});
	return Ok(handed.folder);
}

/**
 * Open a folder the shell registered: for `app`, the folder the shell
 * handed this window, which must be running `app`; for `id`, that folder.
 * Refusals are returned, not thrown: not running in the shell, a window
 * that runs another app or none (`AppMismatch`), a missing ID, a
 * folder this window may not use, an `epicenter.json` that cannot be used,
 * or one that does not contain the definition. Opening creates no
 * repository; the first commit does.
 */
export async function openAnyFolder<
	const TDefinition extends Definition = Definition,
>(
	options: OpenFolderOptions<TDefinition>,
): Promise<Result<Folder<TDefinition, Definition>, OpenFolderError>> {
	if (!isTauri()) return OpenFolderError.NotTauri();
	let id: string;
	if (options.app === undefined) id = options.id;
	else {
		const { data: handed, error: handedError } = await handedFolder(
			options.app,
		);
		if (handedError !== null) return Err(handedError);
		id = handed;
	}
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
}

/** The opener, every form typed (`OpenFolder`). */
export const openFolder: OpenFolder = openAnyFolder;
