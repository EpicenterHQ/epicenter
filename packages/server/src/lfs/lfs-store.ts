/**
 * Where Git LFS objects live, per repository (spike 6's recommendation 8:
 * an object is reachable only through its repository's grant). Disk on the
 * Bun host (`disk-lfs-store.ts`); R2 with presigned URLs follows in phase 7.
 *
 * Only verified bytes are ever stored: `put` checks the sha256 the object is
 * named by before the object becomes visible, so `verified` reduces to "is
 * it there, with this size". The receiver and the translator admit a
 * pointer only when `verified` holds (decision 40, codex-1's amendment).
 */

export type LfsObject = { oid: string; size: number };

export const LFS_OID = /^[0-9a-f]{64}$/;

export type LfsPutResult =
	| { ok: true; size: number }
	| { ok: false; reason: 'hash-mismatch' | 'size-mismatch' | 'too-large' };

export type LfsStore = {
	/** Whether `object` is stored for `repositoryId` with exactly its size. */
	verified(repositoryId: string, object: LfsObject): Promise<boolean>;
	/**
	 * Store `body` as `oid` when its sha256 is `oid` (and its length `size`,
	 * when given). Storing an object already there is not an error.
	 */
	put(
		repositoryId: string,
		oid: string,
		body: ReadableStream<Uint8Array>,
		size?: number,
	): Promise<LfsPutResult>;
	/** The stored bytes of `oid`, or null. */
	get(
		repositoryId: string,
		oid: string,
	): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
};
