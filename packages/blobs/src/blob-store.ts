import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';

/**
 * @fileoverview The canonical local blob store contract.
 *
 * The local store is where app operations read and write bytes; the remote
 * (see `blob-remote.ts`) is an optional, explicit copy target. Both are
 * address-only: they act on a {@link BlobId} the application already knows
 * and never enumerate ids or reconstruct application state. Application data
 * (a recording row, a document citation) supplies each id's meaning.
 *
 * Deliberately absent, so implementations cannot grow them by accident:
 * - `list`/`clear`: blob capabilities are address-only. Bulk operations
 *   iterate the ids the application's own data knows about.
 */

export const BlobStoreError = defineErrors({
	/** The id already names immutable local bytes and cannot be overwritten. */
	BlobAlreadyExists: ({ id }: { id: BlobId }) => ({
		message: `Blob '${id}' already exists.`,
		id,
	}),
	/**
	 * The store holds no bytes for this id. Expected, not exceptional: a row
	 * can sync to a device before (or without) its bytes ever being copied
	 * there. Callers branch on this to offer a remote download.
	 */
	BlobNotFound: ({ id }: { id: BlobId }) => ({
		message: `No local bytes stored for blob '${id}'.`,
		id,
	}),
	/** The underlying storage operation itself failed (IO, quota, corruption). */
	BlobStoreFailed: ({ id, cause }: { id: BlobId; cause: unknown }) => ({
		message: `Blob store operation failed for blob '${id}': ${extractErrorMessage(cause)}`,
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
	attachment?: AttachmentContent & {
		/** Absent on downloads; null denotes a Local publication. */
		originGeneration?: number | null;
		pendingUpload: boolean;
	};
};

/** Immutable evidence computed from the complete file at publication. */
export type AttachmentContent = {
	sha256: string;
	size: number;
	contentType: string;
};

/** A finished host capture, never a path or an audio-sized WebView payload. */
export type NativeFinishedFile = { kind: 'native-capture'; id: string };
export type FinishedFile = Blob | NativeFinishedFile;

export const AttachmentTransferError = defineErrors({
	Failed: ({
		kind,
		cause,
		status,
	}: {
		kind: 'transport' | 'storage' | 'conflict';
		cause: unknown;
		status?: number;
	}) => ({
		message: `Attachment ${kind} failure: ${extractErrorMessage(cause)}`,
		kind,
		cause,
		status,
	}),
});
export type AttachmentTransferError = InferErrors<
	typeof AttachmentTransferError
>;

export type AttachmentBytes = {
	/** One signed byte request. The library owns authorization and delivery acknowledgment. */
	upload(
		id: BlobId,
		expected: AttachmentContent,
		ticket: {
			url: string;
			requiredHeaders: Record<string, string>;
		},
		signal: AbortSignal,
	): Promise<Result<void, AttachmentTransferError>>;
	/** Verify before immutable publication; downloaded bytes create no upload obligation. */
	download(
		id: BlobId,
		expected: AttachmentContent,
		ticket: {
			url: string;
		},
		signal: AbortSignal,
	): Promise<Result<void, AttachmentTransferError>>;
	put(
		id: BlobId,
		file: FinishedFile,
		originGeneration?: number | null,
	): Promise<Result<AttachmentContent, BlobAlreadyExists | BlobStoreFailed>>;
	acknowledge(
		id: BlobId,
		expected: AttachmentContent,
		generation: number,
	): Promise<Result<void, BlobNotFound | BlobStoreFailed>>;
};

/**
 * Canonical local blob operations. Implementations are platform-owned
 * (browser IndexedDB, Bun filesystem, the desktop WebView's HTTP adapter);
 * this contract is what callers and the remote compose over.
 */
export type BlobStore = {
	/** Library-owned attachment publication; legacy ID readers do not use it. */
	attachments?: AttachmentBytes;
	/**
	 * Store bytes under a freshly minted id. Blob ids are immutable:
	 * implementations return `BlobAlreadyExists` instead of replacing bytes.
	 */
	put(
		id: BlobId,
		blob: Blob,
	): Promise<Result<void, BlobAlreadyExists | BlobStoreFailed>>;
	/**
	 * Copy local bytes to a fresh id in this same captured store. The source
	 * stays unchanged and either id can be deleted independently. An existing
	 * destination (including the source id itself) is never overwritten.
	 */
	copy(
		sourceId: BlobId,
		destinationId: BlobId,
	): Promise<Result<void, BlobNotFound | BlobAlreadyExists | BlobStoreFailed>>;
	/**
	 * Read the bytes for an id. `BlobNotFound` is the expected answer when
	 * the bytes were never stored on this device.
	 */
	get(id: BlobId): Promise<Result<Blob, BlobNotFound | BlobStoreFailed>>;
	/** Read size and content type without loading the bytes. */
	stat(id: BlobId): Promise<Result<BlobStat, BlobNotFound | BlobStoreFailed>>;
	/**
	 * Read metadata for supplied ids, in input order. Browser stores use one
	 * metadata transaction. Empty input performs no I/O; this never enumerates ids.
	 */
	statMany(
		ids: readonly BlobId[],
	): Promise<Result<BlobStat, BlobNotFound | BlobStoreFailed>[]>;
	/** Remove the local bytes for an id. Idempotent: missing bytes are `Ok`. */
	delete(id: BlobId): Promise<Result<void, BlobStoreFailed>>;
};
