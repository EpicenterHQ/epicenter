/**
 * Bun-native storage utilities shared by the runtime opener and server-side
 * Bun deployments (blob staging and content files on the local filesystem).
 */
export {
	type BlobByteSource,
	type BunBlobRead,
	createBunBlobFileStore,
} from './store/replica/bun-blob-files.js';
