/**
 * `@epicenter/folder/sync`: sync a store with a repository through the
 * store contract and a manifest (ADR-0803, ADR-0804), the moments an open
 * app syncs at (`syncAtMoments`), and a folder's repository on the server
 * (`folderRepository`, and `joinFolder`, a first sync's join or make). The
 * platform's operations over it are `@epicenter/folder/platform`.
 */
export { localStoreOf } from '../folder.js';
export {
	type FolderCommit,
	folderRepository,
	type Joined,
	joinFolder,
	type RemoteAccount,
	RemoteError,
} from '../remote/repository.js';
export {
	type SyncMoments,
	type SyncResult,
	syncAtMoments,
	type WindowShown,
} from './moments.js';
export {
	type CommitReceipt,
	type CommitRefusal,
	type CommitWrite,
	memoryRepository,
	type Repository,
	type TreeEntry,
} from './repository.js';
export {
	emptyManifest,
	MANIFEST_PATH,
	type Manifest,
	type ManifestStore,
	type ManifestVersion,
	memoryManifest,
	type RepositoryAddress,
	type RootIdentity,
	type SyncReport,
	storeManifest,
	sync,
} from './sync.js';
