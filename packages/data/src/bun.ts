import { openBunRecordOwner } from './bun-record-owner.js';

export {
	type BlobByteSource,
	type BunBlobRead,
	createBunBlobFileStore,
} from './store/replica/bun-blob-files.js';

export type OpenBunRecordEpicenterOptions = { directory: string };

/** Open the greenfield V1 record replica and its raw-file blob owner. */
export async function openBunRecordEpicenter({
	directory,
}: OpenBunRecordEpicenterOptions) {
	return (await openBunRecordOwner({ directory })).owner;
}
