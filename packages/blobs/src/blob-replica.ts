import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';
import type { BlobNotFound, BlobStoreFailed } from './blobs.js';

/**
 * @fileoverview The optional remote replica contract.
 *
 * A replica copies whole objects between the canonical local store and one
 * remote, under the same {@link BlobId}, only when explicitly asked (a user
 * action or a one-shot auto-upload policy). Bytes never pass through the
 * caller: an implementation composes over a `Blobs` store
 * (`createSomeReplica({ blobs, ... })`) and moves bytes itself.
 *
 * Every operation is one-shot. There is deliberately no background sync, no
 * eager download, no retry queue, and no persisted upload-failure state: a
 * failed copy is a returned `Err` the caller acts on now or drops.
 */

export const BlobReplicaError = defineErrors({
	/**
	 * The replica holds no object for this id. Expected, not exceptional:
	 * the object may simply never have been uploaded.
	 */
	RemoteBlobNotFound: ({ id }: { id: BlobId }) => ({
		message: `Replica has no object for blob '${id}'.`,
		id,
	}),
	/** The remote operation itself failed (transport, auth, server). */
	BlobReplicaFailed: ({ id, cause }: { id: BlobId; cause: unknown }) => ({
		message: `Replica operation failed for blob '${id}': ${extractErrorMessage(cause)}`,
		id,
		cause,
	}),
});
export type BlobReplicaError = InferErrors<typeof BlobReplicaError>;
export type RemoteBlobNotFound = InferError<
	typeof BlobReplicaError.RemoteBlobNotFound
>;
export type BlobReplicaFailed = InferError<
	typeof BlobReplicaError.BlobReplicaFailed
>;

/**
 * Explicit same-id copy operations against one remote replica. Local-store
 * errors surface unmapped (typed errors compose bottom-up), so callers can
 * distinguish "this device has no bytes to upload" from "the copy failed".
 */
export type BlobReplica = {
	/**
	 * Copy the object local -> remote. `BlobNotFound` means this device has
	 * no bytes for the id, so there is nothing to upload.
	 */
	upload(
		id: BlobId,
	): Promise<Result<void, BlobNotFound | BlobStoreFailed | BlobReplicaFailed>>;
	/**
	 * Copy the object remote -> local, writing through the canonical store.
	 * `RemoteBlobNotFound` means the object was never uploaded.
	 */
	download(
		id: BlobId,
	): Promise<
		Result<void, RemoteBlobNotFound | BlobStoreFailed | BlobReplicaFailed>
	>;
	/** Delete the remote object. Idempotent; local bytes are untouched. */
	purge(id: BlobId): Promise<Result<void, BlobReplicaFailed>>;
};
