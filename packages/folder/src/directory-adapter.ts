/**
 * A folder in an ordinary directory a trusted host has given this code: the
 * desktop page's granted directory, or a directory a Bun process names.
 * Files go through the storage the host supplies: the shell's storage
 * commands on the desktop (`tauri-files.ts`), and the directory's storage
 * over `node:fs` in Bun (`directory-store.ts`); history is whatever the host
 * supplies:
 * the system `git` run in this process (`git/native-history.ts`, Bun), or
 * the `epicenter` CLI the shell runs for a page (`tauri-history.ts`,
 * ADR-0559). Nothing of the browser folder's OPFS directory or private Git
 * is here.
 */
import type { Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import type { FolderDefinition } from './definition.js';
import type { OpenFolderError } from './errors.js';
import type { Folder, FolderHistory } from './folder.js';
import { type ChangeDetector, openAtRoot } from './open-at-root.js';
import type { Opening } from './opening.js';

/**
 * A directory folder's history, made when the folder opens: `landed` hears
 * the paths an incoming update wrote. Answers the history for the definition
 * the handle reads with; without one, Sync merges rows as text.
 */
export type DirectoryHistory = (wiring: {
	readonly landed: (paths: readonly string[]) => void;
}) => Promise<(definition?: FolderDefinition) => FolderHistory>;

/**
 * Open the folder in an ordinary directory a trusted host has already given
 * this page: the desktop app's shell decides the directory, takes the lock
 * that keeps other processes out of it, and grants the page access to it.
 *
 * The directory is the folder, and a repository someone already made there
 * is used as it is. Opening creates nothing: a directory with no repository
 * gets one with its first commit or remote. In the opening app's own folder
 * the handle publishes the app's definition to `epicenter.json` before its
 * first write; in any other it reads with the folder's own `epicenter.json`
 * and never writes it (`Opening`).
 * Files are read and written through the host's storage. History is real
 * Git on every host, so it honors Git's lock files,
 * packed refs, and configuration, and another Git program can share the
 * repository; `history` decides which process runs it.
 *
 * A save is checked where it lands: the desktop shell checks each put
 * against what the page expects, and in Bun the check runs just before the
 * rename, under the save lock. Across processes, the shell and the Bun host each hold the folder's save lock
 * across one check and rename (ADR-0562), so saves wait only for each other
 * and only for that long. A commit moves the branch only by compare-and-swap,
 * and Git's own lock files keep its index whole. Each handle orders its own
 * Git work.
 *
 * `detector` is the host's one detector of changes made outside the handle
 * (ADR-0548): the shell's watcher on the desktop, none in Bun.
 */
export async function openDirectoryFolder<
	TDefinition extends FolderDefinition,
>({
	opening,
	rootPath,
	storage,
	history,
	detector,
}: {
	/** Which folder this is, and how it is read. */
	readonly opening: Opening;
	/** The directory's absolute path, for showing to a person and naming locks. */
	readonly rootPath: string;
	/** The directory's storage, which the host also gives the history it runs in this process. */
	readonly storage: FolderStorage;
	/** The folder's history. */
	readonly history: DirectoryHistory;
	/** The host's detector of changes made outside the handle. */
	readonly detector?: ChangeDetector;
}): Promise<Result<Folder<TDefinition, FolderDefinition>, OpenFolderError>> {
	return openAtRoot<TDefinition>(opening, {
		detector,
		location: { kind: 'directory', root: rootPath },
		async start({ landed }) {
			return { boundary: storage, history: await history({ landed }) };
		},
	});
}
