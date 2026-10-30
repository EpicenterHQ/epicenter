/**
 * A guarded write of one file through a folder's storage: `confirmedPut`
 * reads a put whose reply was lost back once, and `WRITE_ATTEMPTS` bounds how
 * often a write that lost a race to another writer is redone
 * (`declaration-write.ts`).
 */
import { Ok, type Result } from 'wellcrafted/result';
import type { Expectation, FolderStorage, PutOutcome } from './boundary.js';
import type { FileError } from './errors.js';

/**
 * How many times a write is redone when another writer saved the file
 * between its read and its put. One redo covers the usual case, two writes
 * in the same few milliseconds; repeated losses mean something writes the
 * file continuously, and the person hears `KeptChanging` rather than
 * waiting.
 */
export const WRITE_ATTEMPTS = 3;

/**
 * `storage.put`, with a lost reply read back once: the bytes it sent, or no
 * file for a removal, are this put landing after all.
 */
export async function confirmedPut(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	path: string,
	bytes: Uint8Array | null,
	expected: Expectation,
	sha256: string | null,
): Promise<Result<PutOutcome, FileError>> {
	const put = await storage.put(path, bytes, expected);
	if (put.error?.name !== 'Unconfirmed') return put;
	const read = await storage.read(path);
	const landed =
		bytes === null
			? read.error?.name === 'NotFound'
			: read.error === null && read.data.sha256 === sha256;
	return landed
		? Ok({ kind: 'landed', stamp: read.error === null ? read.data.stamp : null })
		: put;
}
