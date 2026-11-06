/**
 * A folder's large bytes in R2, for the Worker, over the bucket binding
 * alone: `folders/<folder id>/blobs/<sha256>`. Bytes stream through the
 * Worker; R2 refuses a `put` whose bytes do not hash to the SHA-256 it is
 * given, so nothing unverified is ever stored. Whether bytes are held is
 * one `head()`, whose recorded SHA-256 and size must match.
 */
import { type BlobPut, type BlobStore, blobKey } from './blob-store.js';

/** The slice of an R2 bucket binding this store calls. */
export type R2BlobBucket = {
	head(
		key: string,
	): Promise<{ size: number; checksums: { sha256?: ArrayBuffer } } | null>;
	get(
		key: string,
	): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
	put(
		key: string,
		body: ReadableStream<Uint8Array>,
		options: { sha256: string },
	): Promise<{ size: number } | null>;
	delete(keys: string | string[]): Promise<void>;
	list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
		objects: { key: string }[];
		truncated: boolean;
		cursor?: string;
	}>;
};

const hex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');

export function createR2BlobStore(bucket: R2BlobBucket): BlobStore {
	/** The stored size of `sha256` when R2 recorded it under that SHA-256, else null. */
	const storedSize = async (folder: string, sha256: string) => {
		const found = await bucket.head(blobKey(folder, sha256));
		const recorded = found?.checksums.sha256;
		return found && recorded && hex(recorded) === sha256 ? found.size : null;
	};
	return {
		async has(folder, sha256, size) {
			return (await storedSize(folder, sha256)) === size;
		},
		async put(folder, sha256, body, size): Promise<BlobPut> {
			const existing = await storedSize(folder, sha256);
			if (existing !== null) {
				await body.cancel();
				return size === undefined || size === existing
					? { ok: true, size: existing }
					: { ok: false, reason: 'size-mismatch' };
			}
			let stored: { size: number } | null;
			try {
				stored = await bucket.put(blobKey(folder, sha256), body, { sha256 });
			} catch (cause) {
				if (/sha-?256|checksum|digest|hash/i.test(String(cause)))
					return { ok: false, reason: 'hash-mismatch' };
				throw cause;
			}
			if (stored === null) throw new Error(`R2 did not store ${sha256}`);
			if (size !== undefined && stored.size !== size)
				return { ok: false, reason: 'size-mismatch' };
			return { ok: true, size: stored.size };
		},
		async get(folder, sha256) {
			const found = await bucket.get(blobKey(folder, sha256));
			return found ? { size: found.size, body: found.body } : null;
		},
		async delete(folder, sha256) {
			await bucket.delete(blobKey(folder, sha256));
		},
		async deleteFolder(folder) {
			const prefix = blobKey(folder);
			let cursor: string | undefined;
			do {
				const page = await bucket.list({ prefix, cursor, limit: 1000 });
				if (page.objects.length > 0)
					await bucket.delete(page.objects.map(({ key }) => key));
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor !== undefined);
		},
	};
}
