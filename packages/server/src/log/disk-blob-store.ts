/**
 * A folder's large bytes on disk, for the Bun host:
 * `<root>/folders/<folder id>/blobs/<sha256>`. An upload streams into
 * `<root>/incoming/`, hashing as it goes, and is renamed into place only
 * when its SHA-256 and length match; anything else is removed, so a partial
 * or wrong upload is never visible.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { type BlobPut, type BlobStore, blobKey } from './blob-store.js';

export function createDiskBlobStore({
	root,
	maxBytes = 2 * 1024 ** 3,
}: {
	root: string;
	/** The largest version accepted; 2 GiB by default. */
	maxBytes?: number;
}): BlobStore {
	const where = (folder: string, sha256?: string) =>
		join(root, ...blobKey(folder, sha256).split('/'));
	const sizeOf = async (path: string) => {
		try {
			const found = await stat(path);
			return found.isFile() ? found.size : null;
		} catch {
			return null;
		}
	};
	return {
		async has(folder, sha256, size) {
			return (await sizeOf(where(folder, sha256))) === size;
		},
		async put(folder, sha256, body, size): Promise<BlobPut> {
			const target = where(folder, sha256);
			const incoming = join(root, 'incoming');
			await mkdir(incoming, { recursive: true });
			const temporary = join(incoming, randomUUID());
			const hash = createHash('sha256');
			let length = 0;
			let tooLarge = false;
			const file = createWriteStream(temporary);
			try {
				const reader = body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					length += value.length;
					if (length > maxBytes || (size !== undefined && length > size)) {
						tooLarge = true;
						await reader.cancel();
						break;
					}
					hash.update(value);
					if (!file.write(value))
						await new Promise<void>((resolve) =>
							file.once('drain', () => resolve()),
						);
				}
			} finally {
				await new Promise<void>((resolve, reject) =>
					file.end((error?: Error | null) =>
						error ? reject(error) : resolve(),
					),
				);
			}
			const refuse = async (
				reason: Exclude<BlobPut, { ok: true }>['reason'],
			) => {
				await rm(temporary, { force: true });
				return { ok: false, reason } as const;
			};
			if (tooLarge)
				return refuse(
					size !== undefined && length <= maxBytes
						? 'size-mismatch'
						: 'too-large',
				);
			if (size !== undefined && length !== size) return refuse('size-mismatch');
			if (hash.digest('hex') !== sha256) return refuse('hash-mismatch');
			await mkdir(dirname(target), { recursive: true });
			await rename(temporary, target);
			return { ok: true, size: length };
		},
		async get(folder, sha256) {
			const path = where(folder, sha256);
			const size = await sizeOf(path);
			if (size === null) return null;
			return {
				size,
				body: Readable.toWeb(
					createReadStream(path),
				) as unknown as ReadableStream<Uint8Array>,
			};
		},
		async delete(folder, sha256) {
			await rm(where(folder, sha256), { force: true });
		},
		async deleteFolder(folder) {
			await rm(dirname(where(folder)), { recursive: true, force: true });
		},
	};
}
