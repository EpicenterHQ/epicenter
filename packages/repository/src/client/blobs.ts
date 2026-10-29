/**
 * Blob bytes on a device, behind one port every host implements. A blob is
 * immutable bytes named by their SHA-256 (the Git LFS oid), so the store
 * needs no index: an object exists exactly when its name does.
 *
 * `seal(stream)` hashes the bytes while it writes them, in one pass with
 * chunk-sized memory, and names the object at the end: the caller never
 * supplies an oid, so no object is ever named by bytes it does not hold.
 * Until the name is given the bytes sit under a temporary name nothing
 * reads, so a host killed mid-seal leaves no object. `read(oid)` answers the
 * host's own handle for the bytes (a `File` in the browser, which a page can
 * read or show without copying), `has` says whether they are here, and
 * `evict` lets them go. Media types come from a path's extension, never
 * from the store.
 *
 * Every implementation passes `BLOB_STORE_CHECKS` (`blobs.checks.ts`): the
 * memory store here under `bun test`, the browser's OPFS store
 * (`hosts/browser/objects.ts`) in Chromium and WebKit.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

/** An LFS oid: lowercase hex SHA-256. Anything else names no object. */
export const OID = /^[0-9a-f]{64}$/;

/** What a seal stored: the bytes' oid and length. */
export type Sealed = { oid: string; size: number };

export const BlobStoreError = defineErrors({
	/** The device's storage refused more bytes: nothing was stored. */
	QuotaExceeded: ({ cause }: { cause: unknown }) => ({
		message: 'This device has no room left for these bytes',
		cause,
	}),
	/** The source stream failed, or storage failed for another reason: nothing was stored. */
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `The bytes could not be stored: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type BlobStoreError = InferErrors<typeof BlobStoreError>;

/** A device's blob store; `THandle` is what a read answers on this host. */
export type BlobStore<THandle> = {
	/** Store the bytes `stream` carries, named by their SHA-256 once all of them are written. */
	seal(stream: ReadableStream<Uint8Array>): Promise<Result<Sealed, BlobStoreError>>;
	/** The bytes named `oid`, or null when they are not here. */
	read(oid: string): Promise<THandle | null>;
	has(oid: string): Promise<boolean>;
	/** Let the bytes named `oid` go; nothing happens when they are not here. */
	evict(oid: string): Promise<void>;
};

/** Whether storage refused bytes for lack of room (`QuotaExceededError` in every browser). */
export const isQuotaExceeded = (cause: unknown) =>
	typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'QuotaExceededError';

/** The one incremental SHA-256 every store hashes with while it writes. */
export function createHasher() {
	const hash = sha256.create();
	return {
		update(chunk: Uint8Array) {
			hash.update(chunk);
		},
		/** The oid of everything given so far; the hasher is spent after. */
		digest: () => bytesToHex(hash.digest()),
	};
}

/** Blob bytes in memory, as `Blob`s: the store `bun test` runs the checks against. */
export function createMemoryBlobStore(): BlobStore<Blob> {
	const objects = new Map<string, Blob>();
	return {
		async seal(stream) {
			const hasher = createHasher();
			const chunks: Uint8Array[] = [];
			let size = 0;
			const reader = stream.getReader();
			try {
				for (let read = await reader.read(); !read.done; read = await reader.read()) {
					hasher.update(read.value);
					chunks.push(read.value.slice());
					size += read.value.byteLength;
				}
			} catch (cause) {
				return BlobStoreError.Failed({ cause });
			}
			const oid = hasher.digest();
			if (!objects.has(oid)) objects.set(oid, new Blob(chunks as BlobPart[]));
			return Ok({ oid, size });
		},
		read: async (oid) => objects.get(oid) ?? null,
		has: async (oid) => objects.has(oid),
		async evict(oid) {
			objects.delete(oid);
		},
	};
}
