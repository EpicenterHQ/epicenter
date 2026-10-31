/**
 * `@epicenter/folder/bun`: open an existing directory as a folder and expose
 * the CLI's independent declaration and query tools and the system `git`
 * runner its sync verbs use. Git is outside a folder's lifetime.
 */

import { OpenFolderError } from './errors.js';
import {
	createFolder,
	type Opened,
	type OpenOptions,
	type Tables,
} from './folder.js';
import { localRoot, openNativeStorage } from './native/directory.js';
import { watchDirectory } from './native/watch.js';
import { storageHost } from './storage.js';

export * from './contract.js';
export { readDirectoryDocuments } from './directory-documents.js';
export {
	basicAuthorization,
	endGitCommands,
	type GitCredentials,
	runGit,
} from './git/native-host.js';
export { queryDocuments } from './query-documents.js';

export async function openFolder<const T extends Tables>({
	directory,
	...options
}: OpenOptions<T> & { readonly directory: string }): Opened<T> {
	const { data: root, error } = await localRoot(directory);
	if (error !== null) return OpenFolderError.InvalidRoot(error);
	return createFolder(
		storageHost(await openNativeStorage(root), {
			watch: watchDirectory(root),
		}),
		options,
	);
}
