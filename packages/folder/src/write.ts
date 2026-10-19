/**
 * The one write of a file in a directory's history (ADR-0576): what Sync's
 * publish (`git/history.ts`) writes each changed path through.
 *
 * `publishFile(storage, path, checkpoint, mergedFile)` reads the live file,
 * merges it over the incoming file by the shared content rules, and puts
 * the result guarded by the hash it read. Another writer landing between the
 * read and the put starts the next attempt, at most `WRITE_ATTEMPTS` times,
 * then `KeptChanging`. A `put` whose reply was lost is read back once: the
 * bytes it sent, or no file for a delete, mean done.
 *
 * The checkpoint is the base, the incoming merged file is current, and the
 * live file is the change, so an edit made while Sync runs stands.
 * Nothing is returned to show a person; each overwrite that lands is logged
 * through `wellcrafted/logger` with the units it replaced.
 */
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileRead, FolderStorage } from './boundary.js';
import { FileError, WriteError } from './errors.js';
import { hashBytes } from './hash.js';
import {
	type FileContent,
	merge,
	type Overridden,
	sameContent,
} from './shared/merge.js';

const log = createLogger('folder/save');

/**
 * How many times a write is redone when another writer saved the file
 * between its read and its put. One redo covers the usual case, two writes
 * in the same few milliseconds; repeated losses mean something writes the
 * file continuously, and the person hears `KeptChanging` rather than
 * waiting.
 */
export const WRITE_ATTEMPTS = 3;

/** A write that landed, or found nothing to change. */
export type Written = {
	readonly path: string;
	/**
	 * The file as the write left it at `path`: the bytes it put, or found
	 * already there when the merge changed nothing, or `null` for no file.
	 */
	readonly file: FileRead | null;
	/** Each unit of the current file the change replaced; logged, never shown. */
	readonly overridden: readonly Overridden[];
};

const encoder = new TextEncoder();

/** Log a live edit that stood over the incoming file. */
function logOverwrite(path: string, overridden: readonly Overridden[]) {
	if (overridden.length === 0) return;
	log.info(`Kept an edit to ${path} over the change Sync brought in`, {
		path,
		units: overridden,
	});
}

/** A file as a write answers it: the bytes and their hash, detached. */
const fileOf = (read: FileRead | null): FileRead | null =>
	read === null
		? null
		: Object.freeze({ bytes: read.bytes, sha256: read.sha256 });

const toBytes = (content: FileContent | null) =>
	typeof content === 'string' ? encoder.encode(content) : content;

/**
 * `storage.put`, with a lost reply read back once: the bytes it sent, or no
 * file for a removal, are this put landing after all.
 */
export async function confirmedPut(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	path: string,
	bytes: Uint8Array | null,
	ifMatch: string | null,
	sha256: string | null,
): Promise<Result<'landed' | 'stale', FileError>> {
	const put = await storage.put(path, bytes, ifMatch);
	if (put.error?.name !== 'Unconfirmed') return put;
	const read = await storage.read(path);
	const landed =
		bytes === null
			? read.error?.name === 'NotFound'
			: read.error === null && read.data.sha256 === sha256;
	return landed ? Ok('landed') : put;
}

/** A storage failure as a write reports it. */
function writeFailure(path: string, error: FileError): WriteError {
	if (error.name === 'Closed' || error.name === 'InvalidPath') return error;
	if (error.name === 'NotAFile' || error.name === 'NotADirectory')
		return FileError.InvalidPath({ path, reason: error.message }).error;
	return FileError.Io({ path, operation: 'write', cause: error }).error;
}

/**
 * Publish one file from Sync's merged tree over the working directory. The
 * live file is read on every attempt and wins units changed since the
 * checkpoint (ADR-0576). Raw source remains repairable (ADR-0503).
 */
export async function publishFile(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	path: string,
	checkpoint: FileContent | null,
	mergedFile: FileContent | null,
): Promise<Result<Written, WriteError>> {
	const own = (content: FileContent | null) =>
		typeof content === 'string' || content === null
			? content
			: new Uint8Array(content);
	const base = own(checkpoint);
	const next = own(mergedFile);
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await storage.read(path);
		if (read.error !== null && read.error.name !== 'NotFound')
			return Err(writeFailure(path, read.error));
		const current = read.error === null ? read.data : null;
		const live = current?.bytes ?? null;
		const merged = await merge(path, { base, current: next, change: live });
		const bytes = toBytes(merged.content);
		if (sameContent(bytes, live))
			return Ok(Object.freeze({ path, file: fileOf(current), overridden: [] }));
		// A current file that stands whole lost nothing, as when a delete gave
		// way to its edit.
		const overridden = sameContent(bytes, next) ? [] : merged.overridden;
		const sha256 = bytes === null ? null : await hashBytes(bytes);
		const { data: put, error } = await confirmedPut(
			storage,
			path,
			bytes,
			current?.sha256 ?? null,
			sha256,
		);
		if (error !== null) return Err(writeFailure(path, error));
		if (put === 'stale') continue;
		logOverwrite(path, overridden);
		return Ok(
			Object.freeze({
				path,
				file:
					bytes === null || sha256 === null ? null : fileOf({ bytes, sha256 }),
				overridden: Object.freeze(overridden),
			}),
		);
	}
	return WriteError.KeptChanging({ path, attempts: WRITE_ATTEMPTS });
}
