/**
 * The folder, framework-neutral (see `folder.ts`). Every read is a `Store` or
 * a lookup: React reads it with `useFolder` from `@epicenter/react/folder`,
 * Svelte through `svelteFolder` from `@epicenter/svelte/folder-next`, and a
 * script with `get()`.
 *
 * This entry replaces `@epicenter/folder` as apps move to it.
 */
export { OpenFolderError } from '../errors.js';
export { ReadError, SaveError } from '../shared/errors.js';
export { EditError, OpenError } from './errors.js';
export {
	createFolder,
	type Data,
	type FileValue,
	type Folder,
	type Patch,
	type Row,
	type RowIssue,
	type Saved,
	type SaveFailure,
	type Table,
	type Tables,
} from './folder.js';
export type { Opened, OpenOptions } from './open.js';
export {
	type Expected,
	type Fetched,
	type FolderHost,
	type Landed,
	type Listed,
	storageHost,
} from './storage.js';
export { createStore, type Store } from './store.js';
