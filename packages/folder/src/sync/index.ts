/**
 * `@epicenter/folder/sync`: sync a store with a repository through the
 * store contract and a manifest (ADR-0803, ADR-0804), the moments an open
 * app syncs at (`syncAtMoments`), and a folder's repository on the server
 * (`folderRepository`, `mintFolder`). The CLI runs it; no app does yet.
 */
export { localStoreOf } from '../folder.js';
export {
	type FolderCommit,
	folderRepository,
	mintFolder,
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
	type SyncReport,
	storeManifest,
	sync,
} from './sync.js';
