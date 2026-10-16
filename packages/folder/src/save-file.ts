/**
 * The one save loop over an existing file (ADR-0551).
 *
 * `table.save`, `kv.set`, and `files.save` are thin calls over `saveFile`:
 *
 * 1. The base's content must hash to the base's own SHA-256; a base without
 *    content, or with other content, is `UnknownBase`. The save swaps on that
 *    hash.
 * 2. On `Conflict` the current file is read. A missing file is `NotFound`: a
 *    save never recreates a deleted file.
 * 3. The base and the edit merge against the current file by the file's kind
 *    (`mergeFile`), and every competing unit settles with the edit's side.
 * 4. The result must read as its kind whenever the edit does; then the save
 *    swaps on the current hash. That repeats at most `WRITE_ATTEMPTS` times,
 *    then `KeptChanging`. An `Unconfirmed` reply is read back once: our
 *    bytes mean done.
 *
 * Every round merges from the edit's own base, never from the previous
 * attempt. `{ merge: false }` stops at the first swap and answers `Conflict`.
 *
 * Where both sides changed one unit, the saver wins (ADR-0575). Nothing is
 * returned to show a person; each overwrite that lands is logged through
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
import { type FileSaveError, TableError } from './errors.js';
import { kvRefusal } from './kv.js';
import { readKvMembers } from './kv-merge.js';
import {
	type FileContent,
	type FileKind,
	type MergeUnit,
	mergeFile,
} from './merge-file.js';
import { parseRow } from './row-text.js';
import { replaceCaptured } from './storage.js';

const log = createLogger('folder/save');

/**
 * How many times a write is redone when another writer saved the file between
 * its read and its write: a save merges again, an update sets its fields
 * again. One redo covers the usual case, two writes in the same few
 * milliseconds; repeated conflicts mean something writes the file
 * continuously, and the person hears `KeptChanging` rather than waiting.
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

/** What `saveFile` wrote. */
type Written = {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: Uint8Array;
	readonly merged: boolean;
};

const encoder = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Every unit settles with the edit's side. */
const OURS = { kind: 'take', side: 'ours' } as const;

/** What a log line names of a unit the saver won. */
function unitOf(unit: MergeUnit) {
	switch (unit.kind) {
		case 'setting':
			return { kind: unit.kind, key: unit.key };
		case 'field':
			return { kind: unit.kind, field: unit.field };
		case 'text':
			return { kind: unit.kind, part: unit.part, regions: unit.regions.length };
		case 'whole':
			return { kind: unit.kind };
	}
}

/** Log that a save landed over another writer's change to `units`. */
export function logOverwrite(path: string, units: readonly MergeUnit[]) {
	if (units.length === 0) return;
	log.info(`Saved over another writer's change to ${path}`, {
		path,
		units: units.map(unitOf),
	});
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
	storage: Pick<FolderStorage, 'apply' | 'read'>,
	kind: FileKind,
	base: ContentCapture,
	edit: Uint8Array,
	{ merge = true }: SaveOptions = {},
): Promise<Result<Written, FileSaveError>> {
	const { data: owned, error: baseError } = ownBase(base);
	if (baseError !== null) return Err(baseError);
	const { path } = owned;
	if ((await hashBytes(owned.bytes)) !== owned.sha256)
		return TableError.UnknownBase({ path });
	const strictEdit = readsAs(kind, edit);
	let expected = owned.sha256;
	let attempt = edit;
	let overwrote: readonly MergeUnit[] = [];
	for (let merges = 0; ; merges++) {
		const { data: saved, error: saveError } = await replaceCaptured(
			storage,
			fileCapture(path, expected),
			attempt,
		);
		if (saveError === null) {
			logOverwrite(path, overwrote);
			return Ok(
				Object.freeze({
					path,
					sha256: saved.sha256,
					bytes: attempt,
					merged: merges > 0,
				}),
			);
		}
		if (saveError.name !== 'Conflict' || !merge) return Err(saveError);
		if (merges === WRITE_ATTEMPTS)
			return TableError.KeptChanging({ path, attempts: WRITE_ATTEMPTS });
		const { data: current, error: readError } = await storage.read(path);
		if (readError !== null) return Err(readError);
		const merged = await mergeFile(kind, {
			base: owned.bytes,
			ours: edit,
			theirs: current.bytes,
		});
		const { data: content, error: problems } = merged.settle(() => OURS);
		if (problems !== null)
			return TableError.InvalidValues({
				issues: problems.map(({ unit, message }) =>
					unit.kind === 'field' ? { message, field: unit.field } : { message },
				),
			});
		// The edit is present, so its side never settles to no file.
		const bytes = toBytes(content as FileContent);
		if (strictEdit && kind.kind !== 'file' && !readsAs(kind, bytes))
			return Err(unreadable(kind, path, current, bytes));
		overwrote = merged.units;
		attempt = bytes;
		expected = current.sha256;
	}
}

const toBytes = (content: FileContent) =>
	typeof content === 'string' ? encoder.encode(content) : content;
