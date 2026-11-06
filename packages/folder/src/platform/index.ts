/**
 * `@epicenter/folder/platform`: every platform operation on folders as a
 * package function (ADR-0817), which Epicenter's programs (the CLI and the
 * Epicenter app) compose, none of them calling another: the Epicenter
 * folder and its home (`listHome`), which directory is which folder
 * (`identify`, ADR-0822) and the question an unbound folder asks
 * (`questionOf`), adding a contract (`initFolder`), a folder's sync
 * (`syncFolder`), cloning, accepting a share into the Epicenter folder,
 * keeping every folder in sync from one request (`syncEvery`,
 * `keepEverySynced`), and the person's folders on the server: listing,
 * sharing, unsharing, accepting, and attaching to apps.
 *
 * It reads and writes through stores, so it runs wherever a store does; the
 * Epicenter folder on this computer comes from `@epicenter/folder/node`
 * (`epicenterRoot`) or, in the Epicenter app, `@epicenter/folder/tauri`.
 */

export type { FolderIdentity } from '../identity.js';
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
	makeFolder,
	type RemoteAccount,
	RemoteError,
} from '../remote/repository.js';
export {
	type Deletions,
	type SyncReport,
	tooManyDeletions,
} from '../sync/sync.js';
export { firstPartyApps, fitsView, type KnownApp, madeBy } from './apps.js';
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
export {
	type BoundFolder,
	type Candidate,
	fileSyncOf,
	type Identified,
	identify,
	type Question,
	questionOf,
	type UnboundFolder,
} from './identify.js';
export { InitError, initFolder } from './init.js';
export {
	type FolderMark,
	type KeptFolders,
	type KeptState,
	keepEverySynced,
} from './keep-synced.js';
export { type Imported, importLegacy } from './legacy.js';
export {
	type FolderRecord,
	type HeldRecord,
	type Records,
	recordPath,
	recordsIn,
	storeStampFile,
} from './records.js';
export {
	type Answer,
	acceptIntoHome,
	cloneIntoHome,
	type EverySync,
	type FolderSync,
	syncEvery,
	syncFolder,
} from './sync-folder.js';
