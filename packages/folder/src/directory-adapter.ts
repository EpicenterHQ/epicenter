/**
 * A folder in an ordinary directory a trusted host has given this code: the
 * desktop page's granted directory, or a directory a Bun process names.
 * Files go through the browser folder's file storage over directory
 * primitives (`directory-handle.ts`); history is whatever the host supplies:
 * the system `git` run in this process (`git/native-history.ts`, Bun), or
 * the `epicenter` CLI the shell runs for a page (`tauri-history.ts`,
 * ADR-0559). Nothing of the browser folder's own address, claim, download,
 * or private Git is here.
 */
import type { Result } from 'wellcrafted/result';
import type { FileBoundary } from './boundary.js';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import {
	type DirectoryPrimitives,
	isStaleScratch,
	SCRATCH_DIRECTORY,
} from './directory-handle.js';
import { OpenFolderError } from './errors.js';
import type { Folder, FolderHistory, GitOf } from './folder.js';
import {
	type ChangeDetector,
	type FolderSchema,
	openAtRoot,
} from './open-at-root.js';
import {
	createOpfsFileBoundary,
	type OpfsDirectoryHandle,
	type OpfsLocks,
} from './opfs-store.js';

/**
 * A directory folder's history, made once its file storage exists:
 * `landed` hears the paths an incoming update wrote. Answers the history
 * for the definition the handle reads with; without one, Sync merges rows
 * as text.
 */
export type DirectoryHistory<THistory extends FolderHistory = FolderHistory> =
	(wiring: {
		readonly boundary: FileBoundary;
		readonly landed: (paths: readonly string[]) => void;
	}) => Promise<(definition?: FolderDefinition) => THistory>;

/**
 * The lock a directory folder's file saves take turns under in one process.
 * Its name comes from the directory alone, so every opener takes turns with
 * the others, whatever ID it opened the directory by.
 */
export function directoryFilesLock(rootPath: string): string {
	return `epicenter-folder-directory-files:${JSON.stringify(['directory', rootPath])}`;
}

/**
 * Open the folder in an ordinary directory a trusted host has already given
 * this page: the desktop app's shell decides the directory, takes the lock
 * that keeps other processes out of it, and grants the page access to it.
 *
 * The directory is the folder: there is no ready marker and no address to
 * claim, and a repository someone already made there is used as it is.
 * Opening creates nothing: a directory with no repository gets one with its
 * first commit, staging, or remote. With a `definition`, the handle
 * publishes it to `epicenter.json` before its first write. With
 * `'declared'`, the handle reads with the folder's own `epicenter.json` and
 * never writes it.
 * Files are read and written through the browser folder's storage over
 * `root`. History is real Git on every host, so it honors Git's lock files,
 * packed refs, and configuration, and another Git program can share the
 * repository; `history` decides which process runs it.
 *
 * A save is checked where it lands: the desktop shell checks each rename
 * against what the page expects, and in Bun the check runs just before the
 * rename, under `locks` so saves within one process take turns. Across
 * processes, the shell and the Bun host each hold the folder's save lock
 * across one check and rename (ADR-0562), so saves wait only for each other
 * and only for that long. A commit moves the branch only by compare-and-swap,
 * and Git's own lock files keep its index whole. Each handle orders its own
 * Git work.
 *
 * `detector` is the host's one detector of changes made outside the handle
 * (ADR-0548): the shell's watcher on the desktop, none in Bun.
 */
export async function openDirectoryFolder<
	const TDefinition extends FolderDefinition,
	TDeclared extends FolderDefinition = TDefinition,
	THistory extends FolderHistory = FolderHistory,
>({
	definition,
	lens,
	root,
	rootPath,
	files,
	history,
	locks,
	detector,
}: {
	/** The opener's definition, or `'declared'` for the folder's own. */
	readonly definition: TDefinition | 'declared';
	/** With `'declared'`, the prepared shape the folder must contain (ADR-0538). */
	readonly lens?: FolderDefinition;
	/** The directory, as a handle over the host's file system. */
	readonly root: OpfsDirectoryHandle;
	/** The directory's absolute path, for showing to a person and naming locks. */
	readonly rootPath: string;
	/** The host's file system, with absolute paths. */
	readonly files: DirectoryPrimitives;
	/** The folder's history. */
	readonly history: DirectoryHistory<THistory>;
	/**
	 * Saves to the directory take turns under these, for a host that checks
	 * and renames in this process (Bun). Without them saves do not wait: the
	 * desktop shell checks each one where it lands.
	 */
	readonly locks?: OpfsLocks;
	/** The host's detector of changes made outside the handle. */
	readonly detector?: ChangeDetector;
}): Promise<
	Result<Folder<TDefinition, TDeclared, GitOf<THistory>>, OpenFolderError>
> {
	let schema: FolderSchema = 'declared';
	if (definition !== 'declared') {
		const { data: prepared, error: definitionError } =
			prepareFolderDefinition(definition);
		if (definitionError !== null)
			return OpenFolderError.InvalidDefinition(definitionError);
		schema = prepared;
	}
	let shape: FolderDefinition | undefined;
	if (lens !== undefined) {
		const { data: prepared, error: lensError } = prepareFolderDefinition(lens);
		if (lensError !== null) return OpenFolderError.InvalidDefinition(lensError);
		shape = prepared;
	}
	// A write that stopped before its rename (a crash, a quit) leaves its
	// staged bytes behind. Another handle or process may be writing the
	// directory now, so only files staged long enough ago to be abandoned are
	// removed. What cannot be removed stays; it is inert.
	const scratch = `${rootPath}/${SCRATCH_DIRECTORY}`;
	try {
		if ((await files.lstat(scratch))?.kind === 'directory') {
			const now = Date.now();
			for (const entry of await files.readDir(scratch))
				if (entry.kind === 'file' && isStaleScratch(entry.name, now))
					await files.remove(`${scratch}/${entry.name}`).catch(() => {});
		}
	} catch {
		// Leftovers are inert; an open that cannot clear them still opens.
	}
	return openAtRoot<TDefinition, TDeclared, THistory>(schema, {
		detector,
		lens: shape,
		location: { kind: 'directory', root: rootPath },
		async start({ relay, landed }) {
			const boundary =
				locks === undefined
					? createOpfsFileBoundary({ root, landed: relay })
					: createOpfsFileBoundary({
							root,
							locks,
							filesLock: directoryFilesLock(rootPath),
							landed: relay,
						});
			return { boundary, history: await history({ boundary, landed }) };
		},
	});
}
