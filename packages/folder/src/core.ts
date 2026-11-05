/**
 * `@epicenter/folder/core`: the folder's types and its open error, the same
 * on every build and with no platform code, for a library that takes a
 * folder or one of its collections. An app opens its folder with
 * `openFolder` from `@epicenter/folder`.
 */
export { OpenFolderError } from './errors.js';
export type {
	Folder,
	FolderCollection,
	FolderFiles,
	FolderLifecycle,
	FolderNotes,
	FolderState,
	NoteEdit,
	NoteEditOptions,
	RevealFolderError,
	Unavailable,
} from './folder.js';
export type { Place } from './place.js';
