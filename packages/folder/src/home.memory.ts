/**
 * `@epicenter/folder` under the `test` condition: `home()` is a new, empty
 * place in memory, whatever the options, so a folder opened at it is ready
 * a microtask from now. A test seeds it through the folder's ordinary
 * methods (`await folder.todos.set(...)`) and mocks no module; what only
 * the world outside the folder does (another program writing a file, a
 * write that waits or fails) it does through `memoryFiles(folder)` from
 * `@epicenter/folder/memory`. Each call is a new place.
 */
import { memory } from './memory.js';
import type { HomeOptions, Place } from './place.js';

export { OpenFolderError } from './errors.js';
export type {
	Folder,
	FolderCollection,
	FolderFiles,
	FolderNotes,
	FolderState,
} from './folder.js';
export { openFolder } from './open-folder.js';
export type { Place } from './place.js';

/** A new, empty place in memory. */
export function home(_options?: HomeOptions): Place {
	return memory();
}
