/**
 * The native `Folder` over the directory the desktop shell bound to this
 * window: `openTauriFolder({ tables })`. The page names no path, scope, or
 * window. The shell chose the directory in trusted Rust and bound it to the
 * window before the window existed, for the window's lifetime.
 *
 * The shell answers each storage method itself (`tauri-files.ts`,
 * ADR-0581), in the directory bound to the calling window: it checks every
 * path and stages a new file's bytes and renames them over the path under
 * the directory's save lock, the one Bun processes take too. Ordinary saves
 * replace the file unconditionally. The page reaches nothing else on disk.
 *
 * The binding owns one recursive native watch. This handle installs its scoped
 * listener before returning the handle and releases it on close; its readers observe outside
 * edits without a file-query timer. Notifications carry paths, never bytes or
 * publication receipts.
 */
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { TSchema as Schema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { hostStorage } from '../boundary.js';
import { saveDelay } from '../document-owner.js';
import { OpenFolderError } from '../errors.js';
import type { DefaultFolderOptions, Folder } from '../folder.js';
import { tauriHostFiles } from '../tauri-files.js';
import { commands, events, type WindowError } from './bindings.gen.js';
import { createNativeFolder, invalidTable } from './engine.js';
import type { FolderObservation } from './watch.js';

/** What a refused open tells the page. */
function openRefusal(refusal: WindowError) {
	switch (refusal.name) {
		case 'NotBound':
			return OpenFolderError.NotBound();
		case 'Missing':
			return OpenFolderError.Missing();
		case 'Unavailable':
			return OpenFolderError.Unavailable({ cause: refusal.message });
		case 'ShuttingDown':
			return OpenFolderError.ShuttingDown();
		default:
			return OpenFolderError.Unavailable({ cause: refusal });
	}
}

/**
 * Open this window's folder. Refusals are returned, not thrown: a table name
 * that cannot be one top-level directory, a page outside the desktop app, a
 * `directory` the page tried to name, a window the shell bound no folder to,
 * a bound directory that is gone, or a shell that cannot answer. Nothing
 * else is opened in its place.
 */
export async function openTauriFolder<
	const TTables extends Record<string, Schema>,
>(
	options: DefaultFolderOptions<TTables>,
): Promise<Result<Folder<TTables>, OpenFolderError>> {
	const { tables, saveAfterMs } = options;
	saveDelay(saveAfterMs);
	const table = invalidTable(tables);
	if (table !== undefined) return OpenFolderError.InvalidTable({ table });
	if (!isTauri()) return OpenFolderError.NotTauri();
	// The types forbid it; a page that passes one anyway is told, not obeyed.
	const named: unknown = (options as { directory?: unknown }).directory;
	if (named !== undefined)
		return OpenFolderError.InvalidRoot({
			root: String(named),
			cause: 'the desktop app opens the folder bound to this window',
		});
	let opened: Awaited<ReturnType<typeof commands.openFolder>>;
	try {
		opened = await commands.openFolder();
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	if (opened.error !== null) {
		const { error } = opened;
		// Tauri also rejects with strings for missing commands or permissions,
		// which the generated bindings pass on as the refusal type; only an
		// object with a name is the shell's own refusal.
		if (typeof error !== 'object' || error === null || !('name' in error))
			return OpenFolderError.Unavailable({ cause: error });
		return openRefusal(error);
	}
	// No owner or reader exists yet. Listening before constructing and returning
	// the passive handle covers every initial read, without replaying old hints.
	let observe: ((paths: FolderObservation) => void) | undefined;
	let stop: () => void;
	try {
		stop = await events
			.folderChanged(getCurrentWebview())
			.listen(({ payload }) => {
				const paths: unknown =
					typeof payload === 'object' && payload !== null
						? payload.paths
						: undefined;
				observe?.(
					Array.isArray(paths) &&
						paths.every((path) => typeof path === 'string')
						? paths
						: null,
				);
			});
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	try {
		return Ok(
			createNativeFolder({
				storage: hostStorage(tauriHostFiles()),
				tables,
				// Every handle in this page is over the window's one directory.
				directory: 'tauri:window',
				saveAfterMs,
				watch(listener) {
					observe = listener;
					return () => {
						observe = undefined;
						stop();
					};
				},
			}),
		);
	} catch (cause) {
		stop();
		throw cause;
	}
}
