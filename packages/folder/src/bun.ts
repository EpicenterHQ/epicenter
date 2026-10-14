/**
 * `@epicenter/folder/bun`: open an ordinary directory as a folder, in Bun.
 *
 * For command-line tools, recovery scripts, and tests that are given a
 * directory. It is not the desktop adapter: a page in the desktop app opens
 * its folder through `@epicenter/folder/tauri`, where the shell's own process
 * holds the directory.
 *
 * The root is explicit, and the caller supplies the author and remote. Its
 * files are the live source, edited concurrently by people, agents, and Git.
 * Checks against the observed version are best effort: another program can
 * race them. Multi-file operations are ordered steps that report partial
 * progress rather than transactions. This process records history itself and
 * does not watch the directory: `onFilesChanged` reports this handle's own
 * saves and incoming updates, not edits made by other programs.
 */

import { Ok, type Result } from 'wellcrafted/result';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import { OpenFolderError } from './errors.js';
import {
	assembleFolder,
	createFileHints,
	type Folder,
	type FolderGitOptions,
} from './folder.js';
import { createHistory } from './git/history.js';
import { createNativeGitBackend } from './git/native-backend.js';
import { nodeGitHost } from './git/native-host.js';
import {
	createNativeFileBoundary,
	resolveNativeRoot,
	verifyNativeLayout,
} from './native-store.js';
import { publishDefinition } from './publish-definition.js';
import { withPublication } from './storage.js';

export * from './contract.js';
export { GitCommandError, type GitRun } from './git/native-backend.js';
export { createGitRunner } from './git/native-host.js';
export { verifyNativeLayout } from './native-store.js';
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

/**
 * Open the directory at `root`. Refusals are returned, not thrown: a
 * definition a folder cannot keep, a root that is not a directory, or one
 * whose private Git state points somewhere else.
 */
export async function openFolder<const TDefinition extends FolderDefinition>({
	root,
	definition,
	git,
}: DirectoryFolderOptions<TDefinition>): Promise<
	Result<Folder<TDefinition>, OpenFolderError>
> {
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(definition);
	if (definitionError !== null)
		return OpenFolderError.InvalidDefinition(definitionError);
	let resolved: string;
	try {
		resolved = await resolveNativeRoot(root);
		await verifyNativeLayout(resolved);
	} catch (cause) {
		return OpenFolderError.InvalidRoot({ root, cause });
	}
	try {
		const boundary = createNativeFileBoundary(resolved);
		const backend = await createNativeGitBackend({
			root: resolved,
			branch: 'main',
			remote: git.remote,
			boundary,
			host: nodeGitHost(resolved),
		});
		const hints = createFileHints();
		const history = createHistory({
			backend,
			boundary,
			author: git.author,
			definition: prepared,
			landed: (paths) => hints.emit(paths),
		});
		const folder = assembleFolder<TDefinition>({
			prepared,
			storage: withPublication({
				storage: boundary,
				history,
				landed: (paths) => hints.emit(paths),
			}),
			history,
			location: { kind: 'directory', root: resolved },
			hints,
			release: async () => {},
		});
		await publishDefinition(prepared, folder.files);
		return Ok(folder);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
}
