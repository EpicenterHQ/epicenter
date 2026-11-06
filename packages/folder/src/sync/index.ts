/**
 * `@epicenter/folder/sync`: sync a store with a repository through the
 * store contract and a manifest (ADR-0803, ADR-0804), and a folder's
 * repository on the server (`folderRepository`; `makeFolder`, which never
 * joins; and `joinApp`, which names its app). Only Epicenter's programs
 * sync on a computer (ADR-0822); the platform's operations over this are
 * `@epicenter/folder/platform`.
 */
export { localStoreOf } from '../folder.js';
export {
	type FolderCommit,
	folderRepository,
	type Joined,
	joinApp,
	makeFolder,
	type RemoteAccount,
	RemoteError,
} from '../remote/repository.js';
export {
	type CommitReceipt,
	type CommitRefusal,
	type CommitWrite,
	memoryRepository,
	type Repository,
	type TreeEntry,
} from './repository.js';
export {
	type Deletions,
	emptyManifest,
	type Manifest,
	type ManifestStore,
	type ManifestVersion,
	memoryManifest,
	type RepositoryAddress,
	type SyncReport,
	storeManifest,
	sync,
	tooManyDeletions,
} from './sync.js';
