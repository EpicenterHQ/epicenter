/**
 * `@epicenter/folder/sync`: sync a store with a repository through the
 * store contract and a manifest (ADR-0803). A prototype: no app or
 * program runs it yet.
 */
export { localStoreOf } from '../folder.js';
export {
	type BatchReceipt,
	type BatchWrite,
	memoryRepository,
	type RemoteFile,
	type Repository,
} from './repository.js';
export {
	type Base,
	emptyManifest,
	MANIFEST_PATH,
	type Manifest,
	type ManifestStore,
	memoryManifest,
	type SyncReport,
	storeManifest,
	sync,
} from './sync.js';
