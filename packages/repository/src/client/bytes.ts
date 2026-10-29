/**
 * A replica's blobs as a page reaches them, wherever the replica runs (a
 * browser's worker, or the same process in Bun): `put` seals bytes into
 * this device's store and only then stores the pointer, and `open` answers
 * a blob's bytes from this device, or downloads, verifies and seals them
 * first. One path for every size: the bytes are a `Blob` the store reads as
 * a stream, never a buffer.
 *
 * A put is the blob write rule's create or replace (core/settle,
 * `settlePointer`): a create expects no file at the path, a replace
 * expects one, and the replica's next commit names the blob it saw, so the
 * server takes it only if that is still there. A put is refused at once,
 * before anything is sealed, for bytes past the server's blob limit.
 *
 * Nothing evicts yet: owed bytes must stay until the server holds them, so
 * an eviction policy (a later phase) must skip every oid the replica owes.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { isNote } from '../core/door.js';
import { parsePointer, writePointer } from '../core/markdown.js';
import { mediaType } from '../core/media.js';
import type { LfsClient } from '../wire/client.js';
import { type BlobStore, type BlobStoreError, type Sealed } from './blobs.js';
import type { Changed, Replica } from './replica.js';

export const BlobError = defineErrors({
	/** A create found a file at the path on this device: nothing was stored. */
	Exists: ({ path }: { path: string }) => ({ message: `There is already a file at ${path}`, path }),
	/** A replace found no file at the path on this device: nothing was stored. */
	NotFound: ({ path }: { path: string }) => ({ message: `There is no file at ${path}`, path }),
	/** A Markdown path is a note, never a blob. */
	NotBlob: ({ path }: { path: string }) => ({ message: `${path} is a note, not a file of bytes`, path }),
	/** The bytes are more than the repository takes: nothing was sealed. */
	TooLarge: ({ size, limit }: { size: number; limit: number }) => ({ message: `The file is ${size} bytes; this repository takes at most ${limit}`, size, limit }),
});
export type BlobError = InferErrors<typeof BlobError>;

export const OpenError = defineErrors({
	/** No blob is at the path, or the server has no such bytes. */
	Missing: ({ path }: { path: string }) => ({ message: `There is no file at ${path}`, path }),
	/** The bytes are not here and could not be fetched now (offline, the server failing): try again. */
	Unavailable: ({ path, reason }: { path: string; reason: string }) => ({ message: `${path} cannot be read now: ${reason}`, path, reason }),
});
export type OpenError = InferErrors<typeof OpenError>;

/** A stored blob write: the pointer's bytes, and the change it made. */
export type Put = Sealed & Changed;

export function serveBytes({
	replica,
	store,
	lfs,
}: {
	replica: Pick<Replica, 'read' | 'change' | 'blobLimit'>;
	store: BlobStore<Blob>;
	/** The server's LFS endpoint, or null for a repository kept only on this device. */
	lfs: LfsClient | null;
}) {
	/** Downloads in flight, one per oid. */
	const fetching = new Map<string, Promise<Result<undefined, OpenError>>>();

	async function download(path: string, pointer: Sealed): Promise<Result<undefined, OpenError>> {
		if (lfs === null) return OpenError.Missing({ path });
		const asked = await lfs.batch('download', [pointer]);
		if (asked.error !== null) return OpenError.Unavailable({ path, reason: asked.error.message });
		const answer = asked.data.find((each) => each.oid === pointer.oid);
		const action = answer?.actions?.download;
		if (action === undefined) return answer?.error?.code === 404 ? OpenError.Missing({ path }) : OpenError.Unavailable({ path, reason: answer?.error?.message ?? 'no download was offered' });
		const body = await lfs.get(action);
		if (body.error !== null) return body.error.name === 'Refused' && body.error.status === 404 ? OpenError.Missing({ path }) : OpenError.Unavailable({ path, reason: body.error.message });
		const sealed = await store.seal(body.data, { expect: pointer });
		return sealed.error === null ? Ok(undefined) : OpenError.Unavailable({ path, reason: sealed.error.message });
	}

	return {
		/** Seal `blob`, then store a pointer to it at `path`: a create where this device shows no file, a replace where it shows one. */
		async put(path: string, blob: Blob, { replace }: { replace: boolean }): Promise<Result<Put, BlobError | BlobStoreError>> {
			if (isNote(path)) return BlobError.NotBlob({ path });
			const limit = replica.blobLimit();
			if (blob.size > limit) return BlobError.TooLarge({ size: blob.size, limit });
			const there = replica.read(path) !== null;
			if (there !== replace) return replace ? BlobError.NotFound({ path }) : BlobError.Exists({ path });
			const sealed = await store.seal(blob.stream() as ReadableStream<Uint8Array>);
			if (sealed.error !== null) return sealed;
			// Checked again after the seal: a file may have come or gone at the path meanwhile.
			if ((replica.read(path) !== null) !== replace) return replace ? BlobError.NotFound({ path }) : BlobError.Exists({ path });
			const changed = replica.change([{ kind: 'write', path, text: writePointer(sealed.data) }]);
			if (changed.error !== null) throw new Error(changed.error.message);
			return Ok({ ...sealed.data, ...changed.data });
		},
		/** A blob's bytes as a `File` typed by its path's extension: from this device, or fetched and verified first. */
		async open(path: string): Promise<Result<File, OpenError>> {
			const text = replica.read(path);
			const pointer = text === null || isNote(path) ? null : parsePointer(text);
			if (pointer === null) return OpenError.Missing({ path });
			let bytes = await store.read(pointer.oid);
			if (bytes === null) {
				let running = fetching.get(pointer.oid);
				if (running === undefined) {
					running = download(path, pointer).finally(() => fetching.delete(pointer.oid));
					fetching.set(pointer.oid, running);
				}
				const fetched = await running;
				if (fetched.error !== null) return fetched;
				bytes = await store.read(pointer.oid);
				if (bytes === null) return OpenError.Unavailable({ path, reason: 'the bytes were fetched and then gone' });
			}
			// A File over the store's own handle: its bytes are not copied.
			return Ok(new File([bytes], path.slice(path.lastIndexOf('/') + 1), { type: mediaType(path) }));
		},
	};
}
export type Bytes = ReturnType<typeof serveBytes>;
