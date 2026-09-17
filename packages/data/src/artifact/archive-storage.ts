/**
 * Unmounted destination attachment installation from a verified archive.
 * The supplied stores own durability and retention. A successful put alone is
 * insufficient: every object is read back and compared before this layer returns.
 * These operations neither activate a generation nor delete existing objects.
 */
import type {
	BlobId,
	BlobNotFound,
	BlobStore,
	BlobStoreFailed,
} from '@epicenter/blobs';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { ArchiveError, prepareArchive } from './archive.js';

export type ArchiveStorage = Pick<BlobStore, 'put' | 'get'>;
export type StorageError = ArchiveError | BlobNotFound | BlobStoreFailed;

/**
 * Write one immutable object and prove the store kept exactly those bytes.
 *
 * A successful put is not the guarantee; the read-back is. A retry may find its
 * own prior write, and a nominal BlobId is not a content hash, so equality has
 * to be established rather than assumed. Shared by attachment installation and
 * by the retained activation request, which need the same proof for the same
 * reason.
 */
export async function storeVerifiedBlob(
	store: ArchiveStorage,
	id: BlobId,
	blob: Blob,
): Promise<Result<Uint8Array<ArrayBuffer>, StorageError>> {
	const written = await store.put(id, blob);
	if (written.error !== null && written.error.name !== 'BlobAlreadyExists')
		return Err(written.error);
	const read = await store.get(id);
	if (read.error !== null) return read;
	return tryAsync({
		try: async () => {
			const expected = new Uint8Array(await blob.arrayBuffer());
			const actual = new Uint8Array(await read.data.arrayBuffer());
			if (
				read.data.type !== blob.type ||
				actual.length !== expected.length ||
				actual.some((byte, index) => byte !== expected[index])
			)
				throw new Error(
					`Stored blob '${id}' differs from archive bytes or MIME type`,
				);
			return actual;
		},
		catch: (cause) => ArchiveError.InvalidArchive({ cause }),
	});
}

/**
 * Verify a source archive and install every referenced object without overwrite.
 * The v3 archive derives each attachment's canonical type from its complete key.
 * Return fresh-lineage bytes only after all destination read-backs succeed.
 * Partial installation leaves immutable objects that the same request can retry.
 * Every call authors fresh Yjs bytes. Activation retries must retain the original
 * prepared request rather than reconstructing again.
 * The source position is provenance, never the destination activation condition.
 */
export async function installArchive({
	archive,
	blobs,
}: {
	archive: Uint8Array;
	blobs: ArchiveStorage;
}): Promise<
	Result<
		{ source: { generation: number; head: number }; bytes: Uint8Array },
		StorageError
	>
> {
	const prepared = await prepareArchive(archive);
	if (prepared.error !== null) return prepared;
	for (const { id, blob } of prepared.data.blobs) {
		const installed = await storeVerifiedBlob(blobs, id, blob);
		if (installed.error !== null) return installed;
	}
	return Ok({ source: prepared.data.source, bytes: prepared.data.bytes });
}
