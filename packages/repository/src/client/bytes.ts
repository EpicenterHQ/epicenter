/**
 * A replica's blobs as a page reaches them, wherever the replica runs (a
 * browser's worker, or the same process in Bun): `put` seals bytes into
 * this device's store and only then stores the pointer (with any other
 * changes of the same call, in one transaction), and `open` answers
 * a blob's bytes from this device, or downloads, verifies and seals them
 * first. One path for every size: the bytes are a `Blob` the store reads as
 * a stream, never a buffer.
 *
 * A put is the blob write rule's create or replace (core/settle,
 * `settlePointer`): a create expects no file at the path, a replace
 * expects one, and the replica's next commit names the blob it saw, so the
 * server takes it only if that is still there. A put is refused at once,
 * before anything is sealed, for bytes past the server's blob limit. Each
 * file a put stores goes on its own: a pointer waits alone until its bytes
 * are on the server, and the other changes do not wait for it.
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
import type { SaveError } from './page.js';
import type { Change, Changed, ChangeError, Replica } from './replica.js';

/** Why a blob was not stored or opened. */
export const BlobError = defineErrors({
	/** A create found a file at the path on this device: nothing was stored. */
	Exists: ({ path }: { path: string }) => ({ message: `There is already a file at ${path}`, path }),
	/** No file is at the path on this device (a replace, an open), or the server has no such bytes: nothing was stored or opened. */
	NotFound: ({ path }: { path: string }) => ({ message: `There is no file at ${path}`, path }),
	/** A Markdown path is a note, never a blob. */
	NotBlob: ({ path }: { path: string }) => ({ message: `${path} is a note, not a file of bytes`, path }),
	/** Text at a path that is not a note, other than a pointer to bytes: a file of bytes is written as a Blob. */
	NotPointer: ({ path }: { path: string }) => ({ message: `${path} is not a note: write its bytes as a Blob`, path }),
	/** The bytes are more than the repository takes: nothing was sealed. */
	TooLarge: ({ size, limit }: { size: number; limit: number }) => ({ message: `The file is ${size} bytes; this repository takes at most ${limit}`, size, limit }),
	/** The bytes are not here and could not be fetched now (offline, the server failing): try again. */
	Unfetched: ({ path, reason }: { path: string; reason: string }) => ({ message: `${path} cannot be read now: ${reason}`, path, reason }),
});
export type BlobError = InferErrors<typeof BlobError>;

/** One blob to store at a path: a create, or with `replace` a replace, of the file this device shows there. */
export type BlobPut = { path: string; blob: Blob; replace: boolean };

/** A stored put: the change it made, and each path's sealed bytes. */
export type Put = Changed & { sealed: Record<string, Sealed> };

/** Why a put stored nothing. */
export type PutError = BlobError | BlobStoreError | ChangeError | SaveError;

/**
 * Bring the bytes `pointer` names to `store` from the server's LFS endpoint,
 * verified as they are sealed: phase 8's read path, which a page's `open`
 * and the folder engine's projection share. Nothing is stored for bytes
 * that are not the ones named.
 */
export async function downloadBlob({ lfs, store }: { lfs: LfsClient | null; store: BlobStore<Blob> }, path: string, pointer: Sealed): Promise<Result<undefined, BlobError>> {
	if (lfs === null) return BlobError.NotFound({ path });
	const asked = await lfs.batch('download', [pointer]);
	if (asked.error !== null) return BlobError.Unfetched({ path, reason: asked.error.message });
	const answer = asked.data.find((each) => each.oid === pointer.oid);
	const action = answer?.actions?.download;
	if (action === undefined) return answer?.error?.code === 404 ? BlobError.NotFound({ path }) : BlobError.Unfetched({ path, reason: answer?.error?.message ?? 'no download was offered' });
	const body = await lfs.get(action);
	if (body.error !== null) return body.error.name === 'Refused' && body.error.status === 404 ? BlobError.NotFound({ path }) : BlobError.Unfetched({ path, reason: body.error.message });
	const sealed = await store.seal(body.data, { expect: pointer });
	return sealed.error === null ? Ok(undefined) : BlobError.Unfetched({ path, reason: sealed.error.message });
}

export function serveBytes({
	replica,
	store,
	lfs,
}: {
	/** The replica, and the change that stores a call (the page's, so its token is heard with it). */
	replica: Pick<Replica, 'read' | 'blobLimit'> & { change(changes: Change[], token?: number, message?: string): Result<Changed, ChangeError | SaveError> };
	store: BlobStore<Blob>;
	/** The server's LFS endpoint, or null for a repository kept only on this device. */
	lfs: LfsClient | null;
}) {
	/** Downloads in flight, one per oid. */
	const fetching = new Map<string, Promise<Result<undefined, BlobError>>>();

	const download = (path: string, pointer: Sealed) => downloadBlob({ lfs, store }, path, pointer);

	return {
		/**
		 * Seal each blob, then store a pointer to it at its path together with
		 * `changes`, in one change made with `token`. Nothing is
		 * stored unless every blob was sealed and every change applies.
		 */
		async put(blobs: BlobPut[], changes: Change[] = [], token?: number): Promise<Result<Put, PutError>> {
			const misplaced = (path: string, replace: boolean) => ((replica.read(path) !== null) === replace ? null : replace ? BlobError.NotFound({ path }) : BlobError.Exists({ path }));
			const limit = replica.blobLimit();
			for (const { path, blob, replace } of blobs) {
				if (isNote(path)) return BlobError.NotBlob({ path });
				if (blob.size > limit) return BlobError.TooLarge({ size: blob.size, limit });
				const refusal = misplaced(path, replace);
				if (refusal !== null) return refusal;
			}
			const sealed: Record<string, Sealed> = {};
			for (const { path, blob } of blobs) {
				const kept = await store.seal(blob.stream() as ReadableStream<Uint8Array>);
				if (kept.error !== null) return kept;
				sealed[path] = kept.data;
			}
			// Checked again after the seals: a file may have come or gone at a path meanwhile.
			for (const { path, replace } of blobs) {
				const refusal = misplaced(path, replace);
				if (refusal !== null) return refusal;
			}
			const pointers = blobs.map(({ path }): Change => ({ kind: 'write', path, text: writePointer(sealed[path] as Sealed) }));
			const changed = replica.change([...changes, ...pointers], token);
			if (changed.error !== null) return changed;
			return Ok({ ...changed.data, sealed });
		},
		/** A blob's bytes as a `File` typed by its path's extension: from this device, or fetched and verified first. */
		async open(path: string): Promise<Result<File, BlobError>> {
			const text = replica.read(path);
			const pointer = text === null || isNote(path) ? null : parsePointer(text);
			if (pointer === null) return BlobError.NotFound({ path });
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
				if (bytes === null) return BlobError.Unfetched({ path, reason: 'the bytes were fetched and then gone' });
			}
			// A File over the store's own handle: its bytes are not copied.
			return Ok(new File([bytes], path.slice(path.lastIndexOf('/') + 1), { type: mediaType(path) }));
		},
	};
}
export type Bytes = ReturnType<typeof serveBytes>;
