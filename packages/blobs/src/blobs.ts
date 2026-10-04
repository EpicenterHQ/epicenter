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
 * replica (see `blob-replica.ts`) is an optional, explicit copy target. Rows
 * hold only the {@link BlobId}; the store maps that id to bytes.
 *
 * Deliberately absent, so implementations cannot grow them by accident:
 * - `stat`/`exists`: presence is answered by `get` returning `BlobNotFound`;
 *   size and content type ride on the returned `Blob`. A cheap probe gets
 *   added the day a caller genuinely needs presence without bytes.
 * - `list`/`clear`: rows are the only manifest. Bulk operations iterate the
 *   ids the rows know about.
 * - local `copy`: the product sentence's "copy" is the replica seam, not a
 *   local duplicate verb.
 */

export const BlobStoreError = defineErrors({
	/**
	 * The store holds no bytes for this id. Expected, not exceptional: a row
	 * can sync to a device before (or without) its bytes ever being copied
	 * there. Callers branch on this to offer a replica download.
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
export type BlobNotFound = InferError<typeof BlobStoreError.BlobNotFound>;
export type BlobStoreFailed = InferError<typeof BlobStoreError.BlobStoreFailed>;

/**
 * Canonical local blob operations. Implementations are platform-owned
 * (Tauri filesystem, browser IndexedDB); this contract is what callers and
 * the replica compose over.
 */
export type Blobs = {
	/**
	 * Write the bytes for a minted id. Idempotent last-write-wins for the
	 * same object: an id is minted once per object, so the two producers
	 * (a fresh recording, a replica download) never race different bytes
	 * under one id. Content type travels on the `Blob` itself.
	 */
	put(id: BlobId, blob: Blob): Promise<Result<void, BlobStoreFailed>>;
	/**
	 * Read the bytes for an id. `BlobNotFound` is the expected answer when
	 * the bytes were never stored on this device.
	 */
	get(id: BlobId): Promise<Result<Blob, BlobNotFound | BlobStoreFailed>>;
	/** Remove the local bytes for an id. Idempotent: missing bytes are `Ok`. */
	delete(id: BlobId): Promise<Result<void, BlobStoreFailed>>;
};
