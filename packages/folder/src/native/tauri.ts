/**
 * The native `Folder` over a directory the desktop shell registered:
 * `openTauriFolder({ directory, tables })`, where `directory` is the
 * folder's registered ID (its scope), never a path.
 *
 * The shell grants this window the directory (`grant_directory`) and answers
 * each storage method itself (`tauri-files.ts`, ADR-0581): it checks every
 * path, stages a new file's bytes and renames them over the path, and checks
 * the bytes a save expects there under the directory's save lock, the one
 * Bun processes take too. The page reaches nothing else on disk.
 *
 * The shell's watcher reports changes to the directory (ADR-0548), as
 * `other-handle` changes. It sees this handle's own saves too, so a save
 * can also arrive that way; at most a listener rereads a file that did not
 * change.
 */
import { isTauri } from '@tauri-apps/api/core';
import type { TSchema as Schema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { hostStorage, PRIVATE_DIRECTORY } from '../boundary.js';
import { tauriChangeDetector } from '../changes-tauri.js';
import { OpenFolderError } from '../errors.js';
import type { Folder } from '../local-folder.js';
import { tauriHostFiles } from '../tauri-files.js';
import { commands, type GrantError } from './bindings.gen.js';
import { createNativeFolder, invalidTable } from './engine.js';

/** `openTauriFolder`: a registered folder, and how its rows read. */
export type TauriFolderOptions<TTables extends Record<string, Schema>> = {
	/** The ID the shell registered the folder's directory under. */
	readonly directory: string;
	/**
	 * The top-level directories read as Markdown rows, with the schema for
	 * each row's frontmatter. Schemas interpret; they never decide what may
	 * be written.
	 */
	readonly tables: TTables;
};

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

/**
 * Open the folder the shell registered as `directory`. Refusals are
 * returned, not thrown: a table name that cannot be one top-level directory,
 * a page outside the desktop app, an empty ID, an ID the shell does not know
 * or does not permit this window, a directory that is gone, or a shell that
 * cannot answer.
 */
export async function openTauriFolder<
	const TTables extends Record<string, Schema>,
>({
	directory: scope,
	tables,
}: TauriFolderOptions<TTables>): Promise<
	Result<Folder<TTables>, OpenFolderError>
> {
	const table = invalidTable(tables);
	if (table !== undefined) return OpenFolderError.InvalidTable({ table });
	if (!isTauri()) return OpenFolderError.NotTauri();
	if (typeof scope !== 'string' || scope.trim() === '')
		return OpenFolderError.InvalidId({ id: String(scope) });
	let granted: Awaited<ReturnType<typeof commands.grantDirectory>>;
	try {
		granted = await commands.grantDirectory(scope);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	if (granted.error !== null) {
		const { error } = granted;
		// Tauri also rejects with strings for missing commands or permissions,
		// which the generated bindings pass on as the refusal type; only an
		// object with a name is the shell's own refusal.
		if (typeof error !== 'object' || error === null || !('name' in error))
			return OpenFolderError.Unavailable({ cause: error });
		return grantRefusal(error);
	}
	// The shell sweeps a stopped save's staged files at each grant.
	const watch = tauriChangeDetector(scope);
	let heard: ((paths: readonly string[] | null) => void) | undefined;
	const watching = watch((change) => {
		if (change === 'everything') return heard?.(null);
		// `.git` stands for history moving, which changes no file.
		const paths = change.filter((path) => path !== PRIVATE_DIRECTORY);
		if (paths.length > 0) heard?.(paths);
	});
	// A change made once the handle is returned is heard.
	await watching.ready;
	return Ok(
		createNativeFolder({
			storage: hostStorage(tauriHostFiles(scope)),
			tables,
			directory: `tauri:${scope}`,
			detector: (report) => {
				heard = (paths) => report({ paths, origin: 'other-handle' });
				return {
					stop() {
						heard = undefined;
						watching.stop();
					},
				};
			},
		}),
	);
}
