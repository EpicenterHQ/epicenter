/** LFS bytes in memory, verified as they arrive: for tests and for a server that keeps nothing. */

import { Ok } from 'wellcrafted/result';
import { createHasher } from '../client/blobs.js';
import { LFS_OID, type LfsStore, LfsStoreError } from './lfs-store.js';

export function createMemoryLfsStore(): LfsStore {
	const objects = new Map<string, Uint8Array>();
	return {
		async put(oid, size, body) {
			if (!LFS_OID.test(oid) || !Number.isSafeInteger(size) || size < 0) {
				await body.cancel().catch(() => {});
				return LfsStoreError.Mismatch();
			}
			if (objects.has(oid)) {
				await body.cancel().catch(() => {});
				return Ok('present');
			}
			const chunks: Uint8Array[] = [];
			const hasher = createHasher();
			let length = 0;
			const reader = body.getReader();
			try {
				for (
					let read = await reader.read();
					!read.done;
					read = await reader.read()
				) {
					length += read.value.byteLength;
					if (length > size) {
						await reader.cancel();
						return LfsStoreError.Mismatch();
					}
					hasher.update(read.value);
					chunks.push(read.value.slice());
				}
			} catch (cause) {
				return LfsStoreError.Failed({ cause });
			}
			if (length !== size || hasher.digest() !== oid)
				return LfsStoreError.Mismatch();
			const bytes = new Uint8Array(length);
			let at = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, at);
				at += chunk.length;
			}
			if (objects.has(oid)) return Ok('present');
			objects.set(oid, bytes);
			return Ok('stored');
		},
		async has(oid) {
			return LFS_OID.test(oid) && objects.has(oid);
		},
		async get(oid) {
			const bytes = LFS_OID.test(oid) ? objects.get(oid) : undefined;
			return bytes === undefined
				? null
				: {
						body: new Blob([
							bytes as BlobPart,
						]).stream() as ReadableStream<Uint8Array>,
						size: bytes.length,
					};
		},
	};
}
