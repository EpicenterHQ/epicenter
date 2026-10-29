/**
 * LFS bytes on disk, for a self-hosted server (`serveRepository` keeps them
 * at `<repo-dir>/epicenter/blobs/<oid>`, flat). A put writes a temporary
 * file beside its name while hashing, syncs it, and publishes it with a hard
 * link, which fails rather than replace an object already there; the
 * directory is synced after, and the temporary file always removed.
 */
import { createReadStream } from 'node:fs';
import { link, mkdir, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createHasher } from '../client/blobs.js';
import { Ok } from 'wellcrafted/result';
import { LFS_OID, LfsStoreError, type LfsStore } from '../server/lfs-store.js';

/** Files are created beside their final name; a hard link publishes without replacing an existing object. */
export function createFileLfsStore(dir: string): LfsStore {
	const path = (oid: string) => join(dir, oid);
	return {
		async has(oid) {
			if (!LFS_OID.test(oid)) return false;
			try {
				return (await stat(path(oid))).isFile();
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
				throw cause;
			}
		},
		async get(oid) {
			if (!LFS_OID.test(oid)) return null;
			try {
				const info = await stat(path(oid));
				if (!info.isFile()) return null;
				return {
					body: Readable.toWeb(
						createReadStream(path(oid)),
					) as unknown as ReadableStream<Uint8Array>,
					size: info.size,
				};
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
				throw cause;
			}
		},
		async put(oid, size, body) {
			if (!LFS_OID.test(oid) || !Number.isSafeInteger(size) || size < 0) {
				await body.cancel().catch(() => {});
				return LfsStoreError.Mismatch();
			}
			try {
				if (await this.has(oid)) {
					await body.cancel().catch(() => {});
					return Ok('present');
				}
				await mkdir(dir, { recursive: true });
			} catch (cause) {
				return LfsStoreError.Failed({ cause });
			}
			const temp = join(dir, `.upload-${randomUUID()}`);
			let handle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				handle = await open(temp, 'wx');
				const reader = body.getReader();
				const hasher = createHasher();
				let length = 0;
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
					let offset = 0;
					while (offset < read.value.byteLength)
						offset += (await handle.write(read.value, offset)).bytesWritten;
				}
				if (length !== size || hasher.digest() !== oid)
					return LfsStoreError.Mismatch();
				await handle.sync();
				await handle.close();
				handle = undefined;
				try {
					await link(temp, path(oid));
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code === 'EEXIST')
						return Ok('present');
					throw cause;
				}
				const directory = await open(dir, 'r');
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
				return Ok('stored');
			} catch (cause) {
				return LfsStoreError.Failed({ cause });
			} finally {
				await handle?.close();
				await unlink(temp).catch(() => {});
			}
		},
	};
}
