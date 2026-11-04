/**
 * `@epicenter/folder` under the `test` condition: `openFolder` opens a
 * folder in memory, ready at once and empty, whatever the options. A test
 * seeds it through its ordinary methods (`await folder.todos.create(...)`)
 * and mocks no module; what only the world outside the folder does (another
 * program writing a file, a write that waits or fails) it does through
 * `memoryFiles(folder)` from `@epicenter/folder/memory`. Each call is a new
 * folder.
 */
import { Ok } from 'wellcrafted/result';
import { createDeviceClient } from './device/client.js';
import { MEMORY_FILES, memoryStore } from './device/memory-store.js';
import { createFolder, type OpenFolder } from './folder.js';

export { OpenFolderError } from './errors.js';
export type {
	Folder,
	FolderAccount,
	FolderCollection,
	FolderFiles,
	FolderNotes,
	FolderState,
	OpenFolderOptions,
} from './folder.js';

/** A new, empty folder in memory: ready once its open settles, a microtask from now. */
export const openFolder: OpenFolder = (contract) => {
	const store = memoryStore();
	const folder = createFolder(contract, async () =>
		Ok(createDeviceClient(contract, store)),
	);
	Object.defineProperty(folder, MEMORY_FILES, { value: store.outside });
	return folder;
};
