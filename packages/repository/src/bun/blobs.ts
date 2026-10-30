/**
 * Blob bytes on disk, for a replica in Bun (`openLocalRepository`): the
 * device's `BlobStore` over a directory, `<dir>/<oid>` holding an object's
 * bytes exactly, as the browser's OPFS store holds them in `objects/`.
 *
 * A seal writes the stream to a temporary file in the same directory,
 * hashing each chunk as it goes, flushes it to the disk, and renames it
 * onto its oid; bytes a seal did not expect, or a stream that fails, leave
 * nothing. Bytes already under their oid are left alone. A read answers a
 * `BunFile`, a `Blob` that reads the file when asked.
 */
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
	type BlobStore,
	BlobStoreError,
	OID,
	sealStream,
} from '../client/blobs.js';

const isNotFound = (cause: unknown) =>
	typeof cause === 'object' &&
	cause !== null &&
	'code' in cause &&
	cause.code === 'ENOENT';
const isFull = (cause: unknown) =>
	typeof cause === 'object' &&
	cause !== null &&
	'code' in cause &&
	(cause.code === 'ENOSPC' || cause.code === 'EDQUOT');

/** Store blob bytes as files in `directory`, made when first needed. */
export function createFileBlobStore(directory: string): BlobStore<Blob> {
	const pathOf = (oid: string) => join(directory, oid);
	const exists = async (oid: string) =>
		OID.test(oid) &&
		(await stat(pathOf(oid)).then(
			() => true,
			(cause: unknown) => {
				if (isNotFound(cause)) return false;
				throw cause;
			},
		));
	return {
		async seal(stream, { expect } = {}) {
			const temporary = join(directory, `${crypto.randomUUID()}.tmp`);
			try {
				await mkdir(directory, { recursive: true });
				const file = await open(temporary, 'wx');
				let sealed: Awaited<ReturnType<typeof sealStream>>;
				try {
					sealed = await sealStream(
						stream,
						async (chunk, at) =>
							void (await file.write(chunk, 0, chunk.byteLength, at)),
						expect,
					);
					await file.sync();
				} finally {
					await file.close();
				}
				if (sealed.error !== null || (await exists(sealed.data.oid)))
					await rm(temporary, { force: true });
				else await rename(temporary, pathOf(sealed.data.oid));
				return sealed;
			} catch (cause) {
				await rm(temporary, { force: true }).catch(() => {});
				return isFull(cause)
					? BlobStoreError.QuotaExceeded({ cause })
					: BlobStoreError.Failed({ cause });
			}
		},
		read: async (oid) => ((await exists(oid)) ? Bun.file(pathOf(oid)) : null),
		has: exists,
		async evict(oid) {
			if (OID.test(oid)) await rm(pathOf(oid), { force: true });
		},
	};
}
