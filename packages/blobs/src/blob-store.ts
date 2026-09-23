import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';

export const BlobStoreError = defineErrors({
	PublicationUnconfirmed: ({
		id,
		namespace,
		cause,
	}: {
		id: BlobId;
		namespace: string;
		cause: unknown;
	}) => ({
		message: `Publication of '${id}' could not be confirmed.`,
		id,
		destination: { kind: 'local' as const, namespace },
		cause,
	}),
	/** The id already names immutable local bytes and cannot be overwritten. */
	BlobAlreadyExists: ({ id }: { id: BlobId }) => ({
		message: `Blob '${id}' already exists.`,
		id,
	}),
	/** The id has no bytes in this app's local store. */
	BlobNotFound: ({ id }: { id: BlobId }) => ({
		message: `No local bytes stored for blob '${id}'.`,
		id,
	}),
	/** The underlying storage operation itself failed (IO, quota, corruption). */
	BlobStoreFailed: ({ id, cause }: { id?: BlobId; cause: unknown }) => ({
		message: `Blob store operation failed${id ? ` for blob '${id}'` : ''}: ${extractErrorMessage(cause)}`,
		id,
		cause,
	}),
});
export type BlobStoreError = InferErrors<typeof BlobStoreError>;
export type BlobAlreadyExists = InferError<
	typeof BlobStoreError.BlobAlreadyExists
>;
export type BlobNotFound = InferError<typeof BlobStoreError.BlobNotFound>;
export type BlobStoreFailed = InferError<typeof BlobStoreError.BlobStoreFailed>;

/** Metadata that can be read without loading the blob bytes. */
export type BlobStat = {
	size: number;
	contentType: string;
};

/** Exclusive lexicographic cursor; pages are observations, not a snapshot. */
export type BlobListOptions = { cursor?: string; limit?: number };
export type BlobListPage = {
	items: Array<{ id: BlobId; size: number; contentType: string }>;
	nextCursor?: string;
};

/**
 * Canonical local blob operations. Implementations are platform-owned
 * (browser IndexedDB, Bun filesystem, the desktop WebView's HTTP adapter);
 * this contract is what callers and the remote compose over.
 */
export type BlobStore = {
	/** List complete generic blobs. Defaults to 100 entries, at most 1000. */
	list(
		options?: BlobListOptions,
	): Promise<Result<BlobListPage, BlobStoreFailed>>;
	/**
	 * Store bytes under a freshly minted id. Blob ids are immutable:
	 * implementations return `BlobAlreadyExists` instead of replacing bytes.
	 */
	put(
		id: BlobId,
		blob: Blob,
	): Promise<Result<void, BlobAlreadyExists | BlobStoreFailed>>;
	/**
	 * Read the bytes for an id. `BlobNotFound` is the expected answer when
	 * the bytes were never stored on this device.
	 */
	get(id: BlobId): Promise<Result<Blob, BlobNotFound | BlobStoreFailed>>;
	/** Read size and content type without loading the bytes. */
	stat(id: BlobId): Promise<Result<BlobStat, BlobNotFound | BlobStoreFailed>>;
	/** Remove the local bytes for an id. Idempotent: missing bytes are `Ok`. */
	delete(id: BlobId): Promise<Result<void, BlobStoreFailed>>;
};
