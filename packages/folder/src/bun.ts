/**
 * `@epicenter/folder/bun`: open an ordinary directory as a folder, in Bun.
 *
 * For command-line tools, recovery scripts, and tests that are given a
 * directory. A page in the desktop app opens its folder through
 * `@epicenter/folder/tauri` instead, where the shell's own process holds the
 * directory.
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
import { basename, join } from 'node:path';
import type { Result } from 'wellcrafted/result';
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
	let resolved: string;
	try {
		resolved = await realpath(root);
		if (!(await lstat(resolved)).isDirectory())
			throw new Error(`${root} is not a directory`);
		const dotGit = await lstat(join(resolved, '.git')).catch(() => undefined);
		if (dotGit !== undefined && !dotGit.isDirectory())
			throw new Error(`${root}/.git is not a directory of its own`);
	} catch (cause) {
		return OpenFolderError.InvalidRoot({ root, cause });
	}
	return openDirectoryFolder<TDefinition>({
		definition,
		id: basename(resolved),
		root: directoryHandle(nodeDirectoryPrimitives, resolved),
		rootPath: resolved,
		git: { run: createGitRunner(resolved), files: nodeDirectoryPrimitives },
		locks,
		author: git.author,
	});
}
