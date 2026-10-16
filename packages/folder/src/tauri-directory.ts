/**
 * A desktop folder the page opens with its own engine: the shell granted
 * this window the folder's directory (`grant_directory`). The page reads and changes files through the shell, which checks every
 * path. Its history is the `epicenter` CLI's, one child per operation, run
 * by the shell over the system `git` (`tauri-history.ts`, ADR-0559); the
 * page runs no Git. The shell's watcher of the directory tells the page
 * what changed (`epicenter-folder://changed`).
 *
 * Loaded only once a folder is granted, so importing the desktop opener
 * carries none of this.
 */
import type { Result } from 'wellcrafted/result';
import { tauriChangeDetector } from './changes-tauri.js';
import type { FolderDefinition } from './definition.js';
import { openDirectoryFolder } from './directory-adapter.js';
import { directoryHandle } from './directory-handle.js';
import { tauriDirectoryPrimitives } from './directory-tauri.js';
import type { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import type { Granted } from './native/bindings.gen.js';
import { cliHistory } from './tauri-history.js';

export async function openGrantedFolder<
	const TDefinition extends FolderDefinition,
	TDeclared extends FolderDefinition = TDefinition,
>({
	definition,
	lens,
	id,
	granted,
}: {
	/** The page's definition, or `'declared'` for the folder's own. */
	readonly definition: TDefinition | 'declared';
	/** With `'declared'`, the prepared shape the folder must contain. */
	readonly lens?: FolderDefinition;
	readonly id: string;
	readonly granted: Granted;
}): Promise<Result<Folder<TDefinition, TDeclared>, OpenFolderError>> {
	const files = tauriDirectoryPrimitives(id);
	return openDirectoryFolder({
		definition,
		lens,
		root: directoryHandle(files, granted.root),
		rootPath: granted.root,
		files,
		// The CLI commits as the person's Git identity, or as Epicenter where
		// Git names none, and refuses a data folder's first commit inside
		// another repository.
		history: cliHistory({ scope: id }),
		// The shell's watcher is the one detector of outside changes.
		detector: tauriChangeDetector(id),
	});
}
