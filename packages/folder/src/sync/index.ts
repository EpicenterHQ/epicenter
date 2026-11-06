/**
 * `@epicenter/folder/sync`: sync a store with a folder on the server
 * through the store contract and a manifest (ADR-0803, ADR-0804), and the
 * folder on the server (`folderRepository`; `makeFolder`, which never
 * joins; and `joinApp`, which names its app). Only Epicenter's programs
 * sync on a computer (ADR-0822); the platform's operations over this are
 * `@epicenter/folder/platform`.
 */
export { localStoreOf } from '../folder.js';
export {
	type FileAt,
	type FolderRepository,
	folderRepository,
	type ImportedChange,
	type Joined,
	joinApp,
	type LoggedChange,
	type Mark,
	makeFolder,
	type NamedWrite,
	type RemoteAccount,
	RemoteError,
} from '../remote/repository.js';
export {
	type ChangedPath,
	type CommitMoved,
	type CommitReceipt,
	type CommitRefusal,
	type CommitWrite,
	type FileEntry,
	memoryRepository,
	type Repository,
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
