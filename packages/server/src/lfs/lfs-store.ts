/**
 * Where Git LFS objects live, per repository (spike 6's recommendation 8:
 * an object is reachable only through its repository's grant). Disk on the
 * Bun host (`disk-lfs-store.ts`); R2 on Cloudflare (`r2-lfs-store.ts`), whose
 * clients move bytes through presigned URLs rather than this server.
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

/** Where a client sends or fetches an object's bytes itself, and the headers it must send. */
export type LfsAction = {
	href: string;
	header: Record<string, string>;
	/** Seconds the href stays usable. */
	expiresIn: number;
};

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
	/**
	 * A presigned URL that moves `object`'s bytes straight to or from the
	 * store, when it offers them. Without it, the batch API points clients at
	 * this server's own object routes, which call `put` and `get`.
	 */
	presign?(
		repositoryId: string,
		object: LfsObject,
		operation: 'upload' | 'download',
	): Promise<LfsAction>;
};
