/**
 * `@epicenter/folder/platform`: every platform operation on folders as a
 * package function (ADR-0817), which Epicenter's programs (the CLI and the
 * Epicenter app) compose, none of them calling another: the Epicenter
 * folder and its home (`listHome`), which directory is which folder
 * (`identify`, ADR-0822) and the question an unbound folder asks
 * (`questionOf`), adding a contract (`initFolder`), a folder's sync
 * (`syncFolder`), cloning, accepting a share into the Epicenter folder,
 * keeping every folder in sync from one request (`syncEvery`,
 * `keepEverySynced`), a folder's history (its log, a file's versions, the
 * folder at a moment, a diff, a restore, and marks: `history.ts`), a Git
 * repository's history entering as a folder (`importGit`, over a
 * `GitHost`), and the person's folders on the server: listing, sharing,
 * unsharing, accepting, and attaching to apps.
 *
 * It reads and writes through stores, so it runs wherever a store does; the
 * Epicenter folder on this computer comes from `@epicenter/folder/node`
 * (`epicenterRoot`) or, in the Epicenter app, `@epicenter/folder/tauri`.
 * Git itself is the caller's: `gitHost` in `@epicenter/folder/node`, which
 * also exports a history as Git (`exportGit`), or the Epicenter app's shell.
 */

export {
	GitError,
	type GitHost,
	type GitRun,
} from '../git/host.js';
export {
	type ImportNote,
	type ImportReport,
	importGit,
	importsInProgress,
} from '../git/import.js';
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
	type LoggedChange,
	type Mark,
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
	type DiffEntry,
	type FileAtMoment,
	type FileVersion,
	fileAt,
	fileHistory,
	folderAt,
	folderDiff,
	folderLog,
	folderMarks,
	HistoryError,
	type HistoryTarget,
	markFolder,
	type Restored,
	restoreFolder,
	syncedFolder,
} from './history.js';
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
