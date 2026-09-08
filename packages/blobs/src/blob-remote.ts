import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';
import type { BlobNotFound, BlobStoreFailed } from './blob-store.js';

/**
 * @fileoverview The optional remote copy contract.
 *
 * A remote copies whole objects between the canonical local store and one
 * remote destination, under the same {@link BlobId}, only when explicitly
 * asked (a user action or a one-shot auto-upload policy). Bytes never pass
 * through the app caller. Browser implementations may compose over a portable
 * `BlobStore`; desktop implementations are host-owned so they can stream
 * directly from the filesystem rather than materializing recordings in the
 * WebView.
 *
 * Every operation is one-shot. There is deliberately no background sync, no
 * eager download, no retry queue, and no persisted upload-failure state: a
 * failed copy is a returned `Err` the caller acts on now or drops.
 */

export const BlobRemoteError = defineErrors({
	/** This app handle has no account authority to operate a remote copy. */
	RemoteNotConfigured: () => ({
		message: 'Remote blob storage is not configured for this app handle.',
	}),
	/**
	 * The remote holds no object for this id. Expected, not exceptional:
	 * the object may simply never have been uploaded.
	 */
	RemoteBlobNotFound: ({ id }: { id: BlobId }) => ({
		message: `Remote has no object for blob '${id}'.`,
		id,
	}),
	/** The remote operation itself failed (transport, auth, server). */
	BlobRemoteFailed: ({ id, cause }: { id: BlobId; cause: unknown }) => ({
		message: `Remote operation failed for blob '${id}': ${extractErrorMessage(cause)}`,
		id,
		cause,
	}),
});
export type BlobRemoteError = InferErrors<typeof BlobRemoteError>;
export type RemoteNotConfigured = InferError<
	typeof BlobRemoteError.RemoteNotConfigured
>;
export type RemoteBlobNotFound = InferError<
	typeof BlobRemoteError.RemoteBlobNotFound
>;
export type BlobRemoteFailed = InferError<
	typeof BlobRemoteError.BlobRemoteFailed
>;

/**
 * Explicit same-id copy operations against one remote destination. Relevant
 * local-store errors surface unmapped (typed errors compose bottom-up), so
 * callers can distinguish "this device has no bytes to upload" from "the copy
 * failed". Download is the exception: it consumes an immutable-ID collision
 * because the desired local state already exists.
 */
export type BlobRemote = {
	/**
	 * Copy the object local -> remote. `BlobNotFound` means this device has
	 * no bytes for the id, so there is nothing to upload.
	 */
	upload(
		id: BlobId,
	): Promise<Result<void, BlobNotFound | BlobStoreFailed | BlobRemoteFailed | RemoteNotConfigured>>;
	/**
	 * Copy the object remote -> local, writing through the canonical store.
	 * `RemoteBlobNotFound` means the object was never uploaded. An immutable-ID
	 * collision means the requested local state already exists, so remote
	 * implementations consume `BlobAlreadyExists` as idempotent success.
	 */
	download(
		id: BlobId,
	): Promise<
		Result<void, RemoteBlobNotFound | BlobStoreFailed | BlobRemoteFailed | RemoteNotConfigured>
	>;
	/** Delete the remote object. Idempotent; local bytes are untouched. */
	purge(id: BlobId): Promise<Result<void, BlobRemoteFailed | RemoteNotConfigured>>;
};
