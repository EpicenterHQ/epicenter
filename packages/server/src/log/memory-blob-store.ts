/**
 * A folder's large bytes in memory, checked as every store checks them: for
 * a test, or a server whose bytes need not outlive it.
 */
import { type BlobPut, type BlobStore, blobKey } from './blob-store.js';
import { sha256Hex } from './versions.js';

export function createMemoryBlobStore(): BlobStore & {
	/** Every key stored, sorted. */
	keys(): string[];
} {
	const held = new Map<string, Uint8Array>();
	return {
		keys: () => [...held.keys()].sort(),
		async has(folder, sha256, size) {
			return held.get(blobKey(folder, sha256))?.byteLength === size;
		},
		async put(folder, sha256, body, size): Promise<BlobPut> {
			const bytes = new Uint8Array(await new Response(body).arrayBuffer());
			if (size !== undefined && bytes.byteLength !== size)
				return { ok: false, reason: 'size-mismatch' };
			if ((await sha256Hex(bytes)) !== sha256)
				return { ok: false, reason: 'hash-mismatch' };
			held.set(blobKey(folder, sha256), bytes);
			return { ok: true, size: bytes.byteLength };
		},
		async get(folder, sha256) {
			const bytes = held.get(blobKey(folder, sha256));
			if (bytes === undefined) return null;
			return {
				size: bytes.byteLength,
				body: new Response(bytes as Uint8Array<ArrayBuffer>)
					.body as ReadableStream<Uint8Array>,
			};
		},
		async delete(folder, sha256) {
			held.delete(blobKey(folder, sha256));
		},
		async deleteFolder(folder) {
			const prefix = blobKey(folder);
			for (const key of [...held.keys()])
				if (key.startsWith(prefix)) held.delete(key);
		},
	};
}
