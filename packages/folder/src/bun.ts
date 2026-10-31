/**
 * `@epicenter/folder/bun`: open an existing directory as a folder and expose
 * the CLI's independent declaration and query tools, its file lock, the
 * directory save lock, and the system `git` runner its sync verbs use.
 * Folder writes take the save lock, and so does `epicenter sync` while its
 * merge rewrites files; Git is outside its lifetime.
 */

import { sweepStaleScratch } from './directory-store.js';
import { OpenFolderError } from './errors.js';
import {
	createFolder,
	type Opened,
	type OpenOptions,
	type Tables,
} from './folder.js';
import { localRoot, scratchDirectory } from './native/directory.js';
import { nativeStorage, savingPrimitives } from './native/storage.js';
import { watchDirectory } from './native/watch.js';
import { storageHost } from './storage.js';

export { type CreateRowOf, defineTable, field } from '@epicenter/definition';
export * from './contract.js';
export {
	formatDefinition,
	parseDeclaration,
	parseDeclarationObject,
} from './declaration.js';
export {
	type Declaration,
	DeclarationSchema,
	type PortableTableSchema,
	validateTableSchema,
} from './declaration-schema.js';
export { type Definition, defineFolder } from './definition.js';
export { readDirectoryDocuments } from './directory-documents.js';
export { nodeDirectoryPrimitives } from './directory-node.js';
export {
	basicAuthorization,
	endGitCommands,
	GitCommandError,
	type GitCredential,
	type GitCredentials,
	GitMissingError,
	type GitRun,
	locateGit,
	runGit,
} from './git/native-host.js';
export { holdingFileLock, holdingSaveLock } from './native/directory.js';
export { DEFINITION_PATH } from './paths.js';
export { queryDocuments } from './query-documents.js';

export async function openFolder<const T extends Tables>({
	directory,
	...options
}: OpenOptions<T> & { readonly directory: string }): Opened<T> {
	const { data: root, error } = await localRoot(directory);
	if (error !== null) return OpenFolderError.InvalidRoot(error);
	await sweepStaleScratch(scratchDirectory(root), savingPrimitives(root));
	return createFolder(
		storageHost(nativeStorage(root), { watch: watchDirectory(root) }),
		options,
	);
}
