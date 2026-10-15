/**
 * `@epicenter/folder/bun`: open an ordinary directory as a folder, in Bun.
 *
 * For command-line tools, recovery scripts, and tests that are given a
 * directory. `openFolder` opens it with a definition from code, which it
 * publishes to `epicenter.json`; `openDataFolder` opens an existing data
 * folder with its own `epicenter.json`, which it never writes; `readFolder`
 * reads one without opening it. A page in the desktop app opens its folder through
 * `@epicenter/folder/tauri` instead, where the shell grants the page its
 * directory, changes its files, and runs `git` for it.
 *
 * Both open the same directory folder (`openDirectoryFolder`): files through
 * the browser folder's file storage over the directory, replaced by renaming a
 * staged copy over them, and history through the system `git`. Here this
 * process reaches the disk itself, with `node:fs` and its own `git`. The root
 * is explicit and the caller supplies the author for commits Git's
 * configuration does not attribute. The remote is `remote.origin.url` in the
 * directory's Git configuration.
 *
 * Locks are this process's own (`createProcessLocks`): a script and a desktop
 * window on one directory are two writers, kept apart only by Git's lock
 * files and the engine's checks of the observed version (ADR-0533). Nothing
 * watches the directory, so `onFilesChanged` reports this handle's own saves
 * and incoming updates, not other programs' edits.
 */

import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderDefinition } from './definition.js';
import { openDirectoryFolder } from './directory-adapter.js';
import { directoryHandle } from './directory-handle.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { OpenFolderError } from './errors.js';
import type { Folder, FolderGitOptions } from './folder.js';
import { createGitRunner } from './git/native-host.js';
import { createProcessLocks } from './process-locks.js';

export * from './contract.js';
export { GitCommandError, type GitRun } from './git/native-backend.js';
export { createGitRunner } from './git/native-host.js';
export {
	type FolderReading,
	ReadFolderError,
	readFolder,
} from './read-folder.js';

export type DirectoryFolderOptions<TDefinition extends FolderDefinition> = {
	/** An existing directory. A Git repository is initialized there if absent. */
	readonly root: string;
	readonly definition: TDefinition;
	readonly git: FolderGitOptions;
};

export type DataFolderOptions = {
	/** An existing directory. Opening creates nothing in it. */
	readonly root: string;
	readonly git: FolderGitOptions;
};

/** One lock manager for every folder this process opens. */
const locks = createProcessLocks();

/**
 * Open the directory at `root`. Refusals are returned, not thrown: a
 * definition a folder cannot keep, a root that is not a directory, or one
 * whose `.git` is not a directory of its own (a `gitdir:` file or a link
 * points its history somewhere else).
 */
export async function openFolder<const TDefinition extends FolderDefinition>({
	root,
	definition,
	git,
}: DirectoryFolderOptions<TDefinition>): Promise<
	Result<Folder<TDefinition>, OpenFolderError>
> {
	const { data: resolved, error } = await directoryRoot(root);
	if (error !== null) return OpenFolderError.InvalidRoot(error);
	return openDirectoryFolder<TDefinition>({
		definition,
		...directory(resolved),
		author: git.author,
		credentials: git.credentials,
	});
}

/**
 * Open the existing directory at `root` with the schema in its own
 * `epicenter.json`, which the handle never writes (ADR-0535). A directory
 * without one opens with no tables and no settings; one that cannot be used
 * is `InvalidDeclaration`. The root is refused as `openFolder` refuses it.
 *
 * Opening creates nothing. A directory with no repository reads as an empty
 * history with every file uncommitted, and its first commit creates the
 * repository, unless the directory is inside another repository's working
 * tree: that commit is `blocked`, and the files are committed with that
 * repository's Git (ADR-0517).
 */
export async function openDataFolder({
	root,
	git,
}: DataFolderOptions): Promise<
	Result<Folder<FolderDefinition>, OpenFolderError>
> {
	const { data: resolved, error } = await directoryRoot(root);
	if (error !== null) return OpenFolderError.InvalidRoot(error);
	return openDirectoryFolder<FolderDefinition>({
		definition: 'declared',
		initProblem: () => enclosingRepository(resolved),
		...directory(resolved),
		author: git.author,
		credentials: git.credentials,
	});
}

/**
 * `root` with its links resolved, or why it cannot hold a folder: it is not
 * a directory, or its `.git` is not a directory of its own.
 */
async function directoryRoot(
	root: string,
): Promise<Result<string, { root: string; cause: unknown }>> {
	try {
		const resolved = await realpath(root);
		if (!(await lstat(resolved)).isDirectory())
			throw new Error(`${root} is not a directory`);
		const dotGit = await lstat(join(resolved, '.git')).catch(() => undefined);
		if (dotGit !== undefined && !dotGit.isDirectory())
			throw new Error(`${root}/.git is not a directory of its own`);
		return Ok(resolved);
	} catch (cause) {
		return Err({ root, cause });
	}
}

/** This process's file system and `git`, at `resolved`. */
function directory(resolved: string) {
	return {
		root: directoryHandle(nodeDirectoryPrimitives, resolved),
		rootPath: resolved,
		git: { run: createGitRunner(resolved), files: nodeDirectoryPrimitives },
		locks,
	};
}

/**
 * Why `resolved` may not get a repository of its own: a directory above it
 * holds `.git`, so it is inside that repository's working tree.
 */
async function enclosingRepository(
	resolved: string,
): Promise<string | undefined> {
	for (let at = dirname(resolved); ; at = dirname(at)) {
		if ((await lstat(join(at, '.git')).catch(() => undefined)) !== undefined)
			return `${resolved} is inside the repository at ${at}; commit it with that repository's Git`;
		if (dirname(at) === at) return undefined;
	}
}
