/**
 * `@epicenter/folder` under the `test` condition: `openFolder` opens a
 * folder in memory, ready at once and empty, whatever the options. A test
 * seeds it through its ordinary methods (`await folder.todos.create(...)`)
 * and mocks no module. Each call is a new folder.
 */
import { Ok } from 'wellcrafted/result';
import { createDeviceClient } from './device/client.js';
import { memoryStore } from './device/memory-store.js';
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
export const openFolder: OpenFolder = (contract) =>
	createFolder(contract, async () =>
		Ok(createDeviceClient(contract, memoryStore())),
	);
