/**
 * `@epicenter/folder/sync`: sync a store with a repository through the
 * store contract and a manifest (ADR-0803, ADR-0804), and the moments an
 * open app syncs at (`syncAtMoments`). No app or program runs it yet.
 */
export { localStoreOf } from '../folder.js';
export {
	type SyncMoments,
	type SyncResult,
	syncAtMoments,
	type WindowShown,
} from './moments.js';
export {
	type BatchReceipt,
	type BatchRefusal,
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
	type ManifestVersion,
	memoryManifest,
	type SyncReport,
	storeManifest,
	sync,
} from './sync.js';
