/**
 * The one write of a folder file (ADR-0576), and the earlier save loop.
 *
 * `writeFile(storage, kind, path, from, to)` is `folder.write`: it reads the
 * file as it is now, merges the change from `from` to `to` into it by the
 * file's kind (`merge`), where the writer acting wins every unit both
 * changed, and puts the result guarded by the hash it read. Another writer
 * landing between the read and the put starts the next attempt, at most
 * `WRITE_ATTEMPTS` times, then `KeptChanging`. A `put` whose reply was lost
 * is read back once: the bytes it sent, or no file for a delete, mean done.
 *
 * `saveFile` is the save loop `table.save`, `kv.set`, and `files.save` still
 * run: it swaps first on the base's own hash, refuses a base without content
 * (`UnknownBase`) and a deleted file (`NotFound`), and merges the same way.
 *
 * Where both sides changed one unit, the writer wins. Nothing is returned to
 * show a person; each overwrite that lands is logged through
 * `wellcrafted/logger` with the units it replaced.
 */
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import {
	type CapturedFile,
	type ContentCapture,
	fileCapture,
	hashBytes,
	ownCapture,
} from './capture.js';
import {
	FileError,
	type FileSaveError,
	TableError,
	type WriteError,
} from './errors.js';
import { kvRefusal } from './kv.js';
import { readKvMembers } from './kv-merge.js';
import {
	type FileContent,
	type FileKind,
	merge,
	type Overridden,
	sameContent,
} from './merge-file.js';
import { parseRow } from './row-text.js';

const log = createLogger('folder/save');

/**
 * How many times a write is redone when another writer saved the file
 * between its read and its put. One redo covers the usual case, two writes
 * in the same few milliseconds; repeated losses mean something writes the
 * file continuously, and the person hears `KeptChanging` rather than
 * waiting.
 */
export const WRITE_ATTEMPTS = 3;

/** How a save treats a file another writer changed since its base. */
export type SaveOptions = {
	/**
	 * `false` writes only over the base's own bytes, and answers `Conflict`
	 * when the file moved on. Defaults to merging.
	 */
	readonly merge?: boolean;
};

/** A file save that landed. */
export type SavedFile = {
	/** The capture of the bytes written, carrying them. */
	readonly stored: CapturedFile;
	/** Whether another writer changed the file, so the edit was merged with it. */
	readonly merged: boolean;
};

/** A write that landed, or found nothing to change. */
export type Written = {
	readonly path: string;
	/**
	 * The file as the write left it: the bytes it put, or found already
	 * there when the merge changed nothing, or `null` for no file.
	 */
	readonly file: CapturedFile | null;
	/** Each unit where the writer replaced another writer's change; logged, never shown. */
	readonly overridden: readonly Overridden[];
};

/** What `saveFile` wrote. */
type SaveWritten = {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: Uint8Array;
	readonly merged: boolean;
};

const encoder = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Log that a write landed over another writer's change to `overridden`. */
export function logOverwrite(path: string, overridden: readonly Overridden[]) {
	if (overridden.length === 0) return;
	log.info(`Saved over another writer's change to ${path}`, {
		path,
		units: overridden,
	});
}

const toBytes = (content: FileContent | null) =>
	typeof content === 'string' ? encoder.encode(content) : content;

/**
 * `storage.put`, with a lost reply read back once: the bytes it sent, or no
 * file for a removal, are this put landing after all.
 */
async function confirmedPut(
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
 * Write the change from `from` to `to` into the file at `path` as it is
 * now, by `kind` (ADR-0576).
 *
 * `from` is the version the change started from: content, or `null` for no
 * file. `to` is the content, or `null` to delete the file. A delete needs no
 * base, since the deleter wins: its `from` only names the file as
 * overridden when another writer changed it since, and `null` names
 * nothing. Both are owned before anything is awaited.
 *
 * Any `to` is written, whether or not it reads as its kind: a typed view
 * refuses a row it cannot write before it gets here (`InvalidValues`), and
 * a raw edit of a row may be a repair in progress (ADR-0503).
 */
export async function writeFile(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	kind: FileKind,
	path: string,
	from: FileContent | null,
	to: FileContent | null,
): Promise<Result<Written, WriteError>> {
	const own = (content: FileContent | null) =>
		typeof content === 'string' || content === null
			? content
			: new Uint8Array(content);
	const base = own(from);
	const ours = own(to);
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const read = await storage.read(path);
		if (read.error !== null && read.error.name !== 'NotFound')
			return Err(writeFailure(path, read.error));
		const current = read.error === null ? read.data : null;
		const theirs = current?.bytes ?? null;
		const merged =
			ours === null
				? {
						content: null,
						overridden:
							theirs !== null && base !== null && !sameContent(theirs, base)
								? [{ kind: 'file', theirs: 'changed' } as const]
								: [],
					}
				: await merge(kind, { base, ours, theirs });
		const bytes = toBytes(merged.content);
		if (sameContent(bytes, theirs))
			return Ok(
				Object.freeze({
					path,
					file:
						current === null
							? null
							: Object.freeze({
									...fileCapture(path, current.sha256),
									bytes: current.bytes,
								}),
					overridden: [],
				}),
			);
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
		logOverwrite(path, merged.overridden);
		return Ok(
			Object.freeze({
				path,
				file:
					bytes === null || sha256 === null
						? null
						: Object.freeze({ ...fileCapture(path, sha256), bytes }),
				overridden: Object.freeze(merged.overridden),
			}),
		);
	}
	return TableError.KeptChanging({ path, attempts: WRITE_ATTEMPTS });
}

/**
 * The base's path, hash, and content, owned before anything is awaited, or
 * `UnknownBase` when it carries no content.
 */
function ownBase(
	base: ContentCapture,
): Result<{ path: string; sha256: string; bytes: Uint8Array }, FileSaveError> {
	const { data: captured, error } = ownCapture(base);
	if (error !== null) return Err(error);
	const { bytes, text } = base as Partial<{ bytes: unknown; text: unknown }>;
	if (bytes instanceof Uint8Array)
		return Ok({ ...captured, bytes: new Uint8Array(bytes) });
	if (typeof text === 'string')
		return Ok({ ...captured, bytes: encoder.encode(text) });
	return TableError.UnknownBase({ path: captured.path });
}

/**
 * Why a merged result that does not read as its kind is refused: the other
 * writer's file, when it is what does not read, or else the merge's own
 * issues.
 */
function unreadable(
	kind: Exclude<FileKind, { kind: 'file' }>,
	path: string,
	current: { bytes: Uint8Array; sha256: string },
	merged: Uint8Array,
): FileSaveError {
	const decoded = (bytes: Uint8Array) => {
		try {
			return strict.decode(bytes);
		} catch {
			return '';
		}
	};
	const text = decoded(current.bytes);
	const result = decoded(merged);
	const { sha256 } = current;
	if (kind.kind === 'kv')
		return readKvMembers(text) === undefined
			? TableError.InvalidKv({ path, sha256, text, issues: kvRefusal(text) })
					.error
			: TableError.InvalidValues({ issues: kvRefusal(result) }).error;
	const own = parseRow(kind.table, text);
	if (own.error !== null)
		return TableError.InvalidRow({ path, sha256, text, issues: own.error })
			.error;
	const issues = parseRow(kind.table, result).error ?? [
		{ message: 'The merged row does not read as a row' },
	];
	return TableError.InvalidValues({ issues }).error;
}

/** Whether `bytes` read as `kind`. */
function readsAs(kind: FileKind, bytes: Uint8Array): boolean {
	if (kind.kind === 'file') return true;
	let text: string;
	try {
		text = strict.decode(bytes);
	} catch {
		return false;
	}
	if (kind.kind === 'kv') return readKvMembers(text) !== undefined;
	return parseRow(kind.table, text).error === null;
}

/**
 * Save `edit` over `base`, merging with another writer's change by the
 * file's kind. `edit` is owned by the caller's verb, which copied it.
 */
export async function saveFile(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	kind: FileKind,
	base: ContentCapture,
	edit: Uint8Array,
	{ merge: merging = true }: SaveOptions = {},
): Promise<Result<SaveWritten, FileSaveError>> {
	const { data: owned, error: baseError } = ownBase(base);
	if (baseError !== null) return Err(baseError);
	const { path } = owned;
	if ((await hashBytes(owned.bytes)) !== owned.sha256)
		return TableError.UnknownBase({ path });
	const strictEdit = readsAs(kind, edit);
	let expected = owned.sha256;
	let attempt = edit;
	let overwrote: readonly Overridden[] = [];
	for (let merges = 0; ; merges++) {
		const sha256 = await hashBytes(attempt);
		const { data: put, error: putError } = await confirmedPut(
			storage,
			path,
			attempt,
			expected,
			sha256,
		);
		if (putError !== null) return Err(putError);
		if (put === 'landed') {
			logOverwrite(path, overwrote);
			return Ok(
				Object.freeze({ path, sha256, bytes: attempt, merged: merges > 0 }),
			);
		}
		const { data: current, error: readError } = await storage.read(path);
		if (!merging)
			return FileError.Conflict({
				path,
				expectedSha256: expected,
				actualSha256: current?.sha256,
			});
		if (merges === WRITE_ATTEMPTS)
			return TableError.KeptChanging({ path, attempts: WRITE_ATTEMPTS });
		if (readError !== null) return Err(readError);
		const merged = await merge(kind, {
			base: owned.bytes,
			ours: edit,
			theirs: current.bytes,
		});
		// The edit is present, so the merge never settles to no file.
		const bytes = toBytes(merged.content) as Uint8Array;
		if (strictEdit && kind.kind !== 'file' && !readsAs(kind, bytes))
			return Err(unreadable(kind, path, current, bytes));
		overwrote = merged.overridden;
		attempt = bytes;
		expected = current.sha256;
	}
}
