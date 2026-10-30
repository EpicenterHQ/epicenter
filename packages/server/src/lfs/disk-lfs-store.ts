/**
 * Git LFS objects on disk, for the Bun host: `<root>/<repository id>/<aa>/<bb>/<oid>`.
 * An upload streams into `<root>/<repository id>/incoming/`, hashing as it
 * goes, and is renamed into place only when its sha256 and length match;
 * anything else is removed, so a partial or wrong upload is never visible.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LFS_OID, type LfsPutResult, type LfsStore } from './lfs-store.js';

const REPOSITORY_ID = /^[a-z0-9]{16}$/;

export function createDiskLfsStore({
	root,
	maxBytes = 2 * 1024 ** 3,
}: {
	root: string;
	/** The largest object accepted; 2 GiB by default. */
	maxBytes?: number;
}): LfsStore {
	const where = (repositoryId: string, oid: string) => {
		if (!REPOSITORY_ID.test(repositoryId) || !LFS_OID.test(oid))
			throw new Error('not an LFS object address');
		return join(root, repositoryId, oid.slice(0, 2), oid.slice(2, 4), oid);
	};
	const sizeOf = async (path: string) => {
		try {
			const found = await stat(path);
			return found.isFile() ? found.size : null;
		} catch {
			return null;
		}
	};
	return {
		async verified(repositoryId, { oid, size }) {
			if (!LFS_OID.test(oid)) return false;
			return (await sizeOf(where(repositoryId, oid))) === size;
		},
		async put(repositoryId, oid, body, size): Promise<LfsPutResult> {
			const target = where(repositoryId, oid);
			const incoming = join(root, repositoryId, 'incoming');
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
				reason: Exclude<LfsPutResult, { ok: true }>['reason'],
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
			if (hash.digest('hex') !== oid) return refuse('hash-mismatch');
			await mkdir(join(target, '..'), { recursive: true });
			await rename(temporary, target);
			return { ok: true, size: length };
		},
		async get(repositoryId, oid) {
			if (!LFS_OID.test(oid)) return null;
			const path = where(repositoryId, oid);
			const size = await sizeOf(path);
			if (size === null) return null;
			return {
				size,
				body: Readable.toWeb(
					createReadStream(path),
				) as unknown as ReadableStream<Uint8Array>,
			};
		},
	};
}
