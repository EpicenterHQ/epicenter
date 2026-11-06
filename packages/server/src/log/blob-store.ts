/**
 * Where a folder's large bytes live (ADR-0824): every version over
 * `INLINE_MAX`, at `folders/<folder id>/blobs/<sha256>`, per folder. R2 on
 * the Worker (`r2-blob-store.ts`), a directory on the Bun host
 * (`disk-blob-store.ts`, from `@epicenter/server/bun`), memory in a test
 * (`memory-blob-store.ts`). The `blob` table says what a folder holds; the
 * store only keeps bytes.
 *
 * Only bytes whose SHA-256 is their name are ever stored: `put` checks it
 * before the bytes become visible.
 */
import { VERSION } from './versions.js';

export type BlobPut =
	| { ok: true; size: number }
	| { ok: false; reason: 'hash-mismatch' | 'size-mismatch' | 'too-large' };

export type BlobStore = {
	/** Whether `sha256` is stored for `folder` with exactly `size` bytes. */
	has(folder: string, sha256: string, size: number): Promise<boolean>;
	/**
	 * Store `body` as `sha256` when its SHA-256 is `sha256` (and its length
	 * `size`, when given). Storing bytes already there is not an error.
	 */
	put(
		folder: string,
		sha256: string,
		body: ReadableStream<Uint8Array>,
		size?: number,
	): Promise<BlobPut>;
	/** The stored bytes of `sha256`, or null. */
	get(
		folder: string,
		sha256: string,
	): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
	/** Remove `sha256`'s bytes; removing bytes that are not there is not an error. */
	delete(folder: string, sha256: string): Promise<void>;
	/** Remove every byte of `folder`, once its rows are gone. */
	deleteFolder(folder: string): Promise<void>;
};

const FOLDER_ID = /^[a-z0-9]{16}$/;

/** Where `sha256` of `folder` is kept: `folders/<folder>/blobs/<sha256>`. */
export function blobKey(folder: string, sha256?: string): string {
	if (
		!FOLDER_ID.test(folder) ||
		(sha256 !== undefined && !VERSION.test(sha256))
	)
		throw new Error('not a blob address');
	return sha256 === undefined
		? `folders/${folder}/blobs/`
		: `folders/${folder}/blobs/${sha256}`;
}
