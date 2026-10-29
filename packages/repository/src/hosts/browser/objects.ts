/**
 * Blob bytes in a replica's `objects/` directory, beside (never inside) its
 * `sqlite/` pool, which the VFS deletes whole: `objects/<oid>` holds an
 * object's bytes exactly. Content addressing needs no index: an object
 * exists exactly when a file under its oid does. Brought over from the
 * store on claude/repository-blobs (cee13af6ba), moved into the replica
 * layout and onto the `BlobStore` port.
 *
 * A seal writes the stream under a temporary name through a sync access
 * handle, hashing each chunk as it goes, flushes, and moves the file onto
 * its oid at the end; bytes already there are left alone, so every `File`
 * read from them stays readable. A worker that dies mid-seal (a tab closed
 * for good kills its worker) leaves at most a stray temporary file, which
 * nothing reads. A read answers the file itself, which a page can show
 * through an object URL it makes and revokes, and which stays readable
 * after the worker that read it ends. Sync access handles exist only in
 * dedicated workers, so the store runs in the owning tab's worker.
 */
import { Ok } from 'wellcrafted/result';
import { type BlobStore, BlobStoreError, createHasher, isQuotaExceeded, OID } from '../../client/blobs.js';
import { fileIn, isNotFound, type WorkerFileHandle } from './opfs.js';

/** Store blob bytes as files in `directory`, a replica's `objects/`. */
export function createOpfsBlobStore(directory: FileSystemDirectoryHandle) {
	/** Seals in progress, which a close waits for. */
	const sealing = new Set<Promise<unknown>>();
	/** Naming runs one seal at a time, so two seals of the same bytes never both move onto the oid. */
	let naming: Promise<unknown> = Promise.resolve();

	const store: BlobStore<File> = {
		seal(stream) {
			const running = seal(stream);
			sealing.add(running);
			void running.finally(() => sealing.delete(running));
			return running;
		},
		read: async (oid) => (OID.test(oid) ? fileIn(directory, oid) : null),
		has: async (oid) => OID.test(oid) && (await fileIn(directory, oid)) !== null,
		async evict(oid) {
			if (!OID.test(oid)) return;
			await directory.removeEntry(oid).catch((cause: unknown) => {
				if (!isNotFound(cause)) throw cause;
			});
		},
	};

	async function seal(stream: ReadableStream<Uint8Array>) {
		const temporary = `${crypto.randomUUID()}.tmp`;
		const fail = (cause: unknown) => (isQuotaExceeded(cause) ? BlobStoreError.QuotaExceeded({ cause }) : BlobStoreError.Failed({ cause }));
		try {
			const handle = (await directory.getFileHandle(temporary, { create: true })) as WorkerFileHandle;
			const hasher = createHasher();
			let size = 0;
			const access = await handle.createSyncAccessHandle();
			try {
				const reader = stream.getReader();
				for (let read = await reader.read(); !read.done; read = await reader.read()) {
					if (access.write(read.value, { at: size }) !== read.value.byteLength) throw new Error(`The write to '${temporary}' was short`);
					hasher.update(read.value);
					size += read.value.byteLength;
				}
				access.flush();
			} finally {
				access.close();
			}
			const oid = hasher.digest();
			const named = naming.then(async () => {
				// Already here: the bytes under an oid never change, and leaving the file alone keeps every File read from it readable.
				if ((await fileIn(directory, oid)) !== null) await directory.removeEntry(temporary);
				else await handle.move(directory, oid);
			});
			naming = named.catch(() => {});
			await named;
			return Ok({ oid, size });
		} catch (cause) {
			await directory.removeEntry(temporary).catch(() => {});
			return fail(cause);
		}
	}

	return {
		...store,
		/** Wait for every seal in progress. */
		async close() {
			await Promise.allSettled(sealing);
		},
	};
}
export type OpfsBlobStore = ReturnType<typeof createOpfsBlobStore>;
