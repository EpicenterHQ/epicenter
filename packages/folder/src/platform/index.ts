/**
 * `@epicenter/folder/platform`: every platform operation on folders as a
 * package function (ADR-0817), which the CLI, the Epicenter app, and every
 * app's home compose, none of them calling another: the Epicenter folder and
 * its home (`listHome`), adding a contract (`initFolder`), a folder's sync
 * with its two first-sync questions (`syncFolder`), cloning, accepting a
 * share into the Epicenter folder, keeping every folder in sync from one
 * request (`syncEvery`), and the person's folders on the server: listing,
 * sharing, unsharing, accepting, and attaching to apps.
 *
 * It reads and writes through stores, so it runs wherever a store does; a
 * directory's root and identity on this computer come from
 * `@epicenter/folder/node` (`epicenterRoot`, `localFolder`).
 */
export {
	acceptShare,
	attachFolder,
	folderHeads,
	getFolder,
	listFolders,
	shareFolder,
	unshareFolder,
} from '../remote/folders.js';
export {
	type RemoteAccount,
	RemoteError,
} from '../remote/repository.js';
export type { RootIdentity } from '../sync/sync.js';
export {
	describeMembers,
	type EpicenterRoot,
	freeName,
	type Home,
	type HomeFolder,
	type HomeState,
	type LocalFolder,
	listHome,
} from './epicenter-folder.js';
export { InitError, initFolder } from './init.js';
export {
	type FolderMark,
	type KeptFolders,
	type KeptState,
	keepEverySynced,
} from './keep-synced.js';
export {
	acceptIntoHome,
	type CopyAnswer,
	cloneFolder,
	cloneIntoHome,
	type EverySync,
	type FolderSync,
	syncEvery,
	syncFolder,
} from './sync-folder.js';
