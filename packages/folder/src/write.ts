/**
 * The one write of a folder file and the one move (ADR-0576).
 *
 * `writeFile(storage, kind, path, from, to)` is `folder.write`: it reads the
 * file as it is now, merges the change from `from` to `to` into it by the
 * file's kind (`merge`), where the writer acting wins every unit both
 * changed, and puts the result guarded by the hash it read. Another writer
 * landing between the read and the put starts the next attempt, at most
 * `WRITE_ATTEMPTS` times, then `KeptChanging`. A `put` whose reply was lost
 * is read back once: the bytes it sent, or no file for a delete, mean done.
 *
 * `movePath(storage, path, next)` is `folder.move`, which `table.rename`
 * makes too: the bytes land at `next` only where nothing is, and `path` is
 * removed only while it holds them.
 *
 * Where both sides changed one unit, the writer wins. Nothing is returned to
 * show a person; each overwrite that lands is logged through
 * `wellcrafted/logger` with the units it replaced.
 */
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileRead, FolderStorage } from './boundary.js';
import { FileError, WriteError } from './errors.js';
import { hashBytes } from './hash.js';
import {
	type FileContent,
	type FileKind,
	merge,
	type Overridden,
	sameContent,
	type Winner,
} from './merge-file.js';

const log = createLogger('folder/save');

/**
 * How many times a write is redone when another writer saved the file
 * between its read and its put. One redo covers the usual case, two writes
 * in the same few milliseconds; repeated losses mean something writes the
 * file continuously, and the person hears `KeptChanging` rather than
 * waiting.
 */
export const WRITE_ATTEMPTS = 3;

/** Why a move stopped after its copy landed and another writer changed it. */
const CARRY_STOPPED =
	'another writer changed this path after the move copied the file here, so the move stopped: the file stays at its old path, and this path holds what that writer left, if anything';

/** A write or a move that landed, or found nothing to change. */
export type Written = {
	readonly path: string;
	/**
	 * The file as the write left it at `path`: the bytes it put, or found
	 * already there when the merge changed nothing, or `null` for no file.
	 */
	readonly file: FileRead | null;
	/** Each unit where the writer replaced another writer's change; logged, never shown. */
	readonly overridden: readonly Overridden[];
};

const encoder = new TextEncoder();

/** Log that a write landed over another writer's change to `overridden`. */
function logOverwrite(path: string, overridden: readonly Overridden[]) {
	if (overridden.length === 0) return;
	log.info(`Saved over another writer's change to ${path}`, {
		path,
		units: overridden,
	});
}

/** A file as a write or a move answers it: the bytes and their hash, detached. */
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
export function writeFailure(path: string, error: FileError): WriteError {
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
 * nothing. An edit, from a version that existed, of a file deleted since
 * writes nothing and answers `file: null`: a delete beats an edit it never
 * saw, and only a write from no file creates one. A create, from `null`,
 * places a file only where none is: a file already there is `Occupied`,
 * unless it holds the same bytes, which is that create landed before. Both
 * are owned before anything is awaited. With `joining`, a create onto a
 * file merges with it as an addition on both sides instead: what Sync does
 * when it finishes a publish over a file the person made where the
 * published tree adds one, and what a handle does when it publishes its
 * declaration over the one there.
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
	{
		winner = 'ours',
		joining = false,
	}: { readonly winner?: Winner; readonly joining?: boolean } = {},
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
		// A create places a file only where none is. The same bytes already
		// there are this create landed before, so a retried create is done.
		if (base === null && ours !== null && current !== null && !joining) {
			if (sameContent(toBytes(ours), current.bytes))
				return Ok(
					Object.freeze({ path, file: fileOf(current), overridden: [] }),
				);
			return WriteError.Occupied({ path });
		}
		const merged =
			ours === null
				? {
						content: null,
						overridden:
							theirs !== null && base !== null && !sameContent(theirs, base)
								? [{ kind: 'file', lost: 'theirs' } as const]
								: [],
					}
				: await merge(kind, { base, ours, theirs }, { winner });
		const bytes = toBytes(merged.content);
		if (
			merged.overridden.some(
				(unit) => unit.kind === 'file' && unit.lost === 'ours',
			)
		)
			log.info(`Wrote nothing to ${path}: it was deleted since`, { path });
		if (sameContent(bytes, theirs))
			return Ok(Object.freeze({ path, file: fileOf(current), overridden: [] }));
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
					bytes === null || sha256 === null ? null : fileOf({ bytes, sha256 }),
				overridden: Object.freeze(merged.overridden),
			}),
		);
	}
	return WriteError.KeptChanging({ path, attempts: WRITE_ATTEMPTS });
}

/**
 * Move the file at `path` to `next`, as it is (ADR-0576). A move changes
 * where a file is, not what it holds, so it is not a write: its bytes are
 * put at `next` only where nothing is, so two moves onto one path never fuse
 * two files, then `path` is removed only while it holds what moved. A write
 * that lands at `path` meanwhile is carried to `next` first, at most
 * `WRITE_ATTEMPTS` times. A delete of `path` meanwhile stands: the copy at
 * `next` goes too, unless something wrote there since, and the move is
 * `InvalidPath`.
 *
 * No file at `path` is `InvalidPath`, and one already at `next` is
 * `Occupied`; nothing changes. Another writer changing or deleting `next`
 * after the bytes landed there, while a write was being carried, is
 * `InvalidPath` naming `next`: the file stays at `path`, and `next` holds
 * what that writer left, possibly an edited copy, so both paths may hold
 * the file.
 * `path` changing on every attempt is `KeptChanging`; both paths then hold
 * the file, as they do when the removal fails, which a person can see and
 * repair (ADR-0503). A move onto its own path answers the file as it is.
 * The answer is the file as it stands at `next`.
 */
export async function movePath(
	storage: Pick<FolderStorage, 'put' | 'read'>,
	path: string,
	next: string,
): Promise<Result<Written, WriteError>> {
	const read = await storage.read(path);
	if (read.error !== null)
		return read.error.name === 'NotFound'
			? WriteError.InvalidPath({ path, reason: 'no file is at this path' })
			: Err(writeFailure(path, read.error));
	const movedTo = (file: FileRead) =>
		Ok(Object.freeze({ path: next, file: fileOf(file), overridden: [] }));
	if (next === path) return movedTo(read.data);
	let moved = read.data;
	const placed = await confirmedPut(
		storage,
		next,
		moved.bytes,
		null,
		moved.sha256,
	);
	if (placed.error !== null) return Err(writeFailure(next, placed.error));
	if (placed.data === 'stale') return WriteError.Occupied({ path: next });
	for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
		const removed = await confirmedPut(storage, path, null, moved.sha256, null);
		if (removed.error !== null) return Err(writeFailure(path, removed.error));
		if (removed.data === 'landed') return movedTo(moved);
		const now = await storage.read(path);
		if (now.error?.name === 'NotFound') {
			// Deleted while it moved: the delete stands, so its copy at `next`
			// goes too, unless something wrote there.
			const undone = await confirmedPut(
				storage,
				next,
				null,
				moved.sha256,
				null,
			);
			if (undone.error !== null) return Err(writeFailure(next, undone.error));
			return WriteError.InvalidPath({
				path,
				reason: 'no file is at this path',
			});
		}
		if (now.error !== null) return Err(writeFailure(path, now.error));
		const carried = await confirmedPut(
			storage,
			next,
			now.data.bytes,
			moved.sha256,
			now.data.sha256,
		);
		if (carried.error !== null) return Err(writeFailure(next, carried.error));
		// Another writer changed or deleted `next` since the bytes landed
		// there: the file stays at `path`, and `next` is that writer's. This
		// is not `Occupied`: the copy this move put there may have been
		// edited, so both paths can hold the file, or `next` may hold none.
		if (carried.data === 'stale')
			return WriteError.InvalidPath({
				path: next,
				reason: CARRY_STOPPED,
			});
		moved = now.data;
	}
	return WriteError.KeptChanging({ path, attempts: WRITE_ATTEMPTS });
}
