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
 *    swaps on the current hash. That repeats at most `SAVE_MERGES` times,
 *    then `KeptChanging`. An `Unconfirmed` reply is read back once: our
 *    bytes mean done.
 *
 * Every round merges from the edit's own base, never from the previous
 * attempt, so what a save reports it replaced is the last round's alone.
 * `{ merge: false }` stops at the first swap and answers `Conflict`.
 *
 * A save names what it replaced with the content, so "Restore theirs" works
 * when the other side's version exists nowhere else: `restoreTheirs` builds
 * the one more save, over the version the save wrote, that puts theirs back.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import {
	type CapturedFile,
	type ContentCapture,
	fileCapture,
	hashBytes,
	ownCapture,
} from './capture.js';
import type { FolderDefinition } from './definition.js';
import { type FileSaveError, TableError } from './errors.js';
import type { SettledRegion } from './git/merge-lines.js';
import { kvRefusal } from './kv.js';
import { formatKvMembers, readKvMembers } from './kv-merge.js';
import {
	type FileContent,
	type FileKind,
	fileKindOf,
	type MergeUnit,
	mergeFile,
} from './merge-file.js';
import { type AnyRow, setField } from './row-merge.js';
import { formatRow, parseRow, type Row } from './row-text.js';
import { replaceCaptured } from './storage.js';
import type { SavedRow, StoredRow } from './table.js';

/** How many times a save merges with a newer file before it gives up. */
export const SAVE_MERGES = 3;

/** How a save treats a file another writer changed since its base. */
export type SaveOptions = {
	/**
	 * `false` writes only over the base's own bytes, and answers `Conflict`
	 * when the file moved on. Defaults to merging.
	 */
	readonly merge?: boolean;
};

/**
 * One value of another writer's that a save replaced, because both changed
 * it, with what a person needs to put theirs back.
 *
 * - `field`, `setting`: both changed one row field or one `kv.json` key.
 *   `kept` is the value saved and `theirs` theirs; `undefined` on either
 *   side is no such field or key.
 * - `text`: both changed the same lines of a row's body or a text file.
 *   `kept` is the text saved; `theirs` is the same merge with theirs winning
 *   every competing region, so restoring it keeps the edit's other lines.
 *   `regions` name each competing span, standing in `kept` from its line.
 * - `whole`: the file was one unit, because a version is not text, and the
 *   save replaced all of `theirs`.
 */
export type Replaced =
	| {
			readonly kind: 'field';
			readonly field: string;
			readonly kept: unknown;
			readonly theirs: unknown;
	  }
	| {
			readonly kind: 'setting';
			readonly key: string;
			readonly kept: unknown;
			readonly theirs: unknown;
	  }
	| {
			readonly kind: 'text';
			readonly part: 'body' | 'file';
			readonly kept: string;
			readonly theirs: string;
			readonly regions: readonly SettledRegion[];
	  }
	| { readonly kind: 'whole'; readonly theirs: CapturedFile | null };

/** A file save that landed. */
export type SavedFile = {
	/** The capture of the bytes written, carrying them. */
	readonly stored: CapturedFile;
	/** Whether another writer changed the file, so the edit was merged with it. */
	readonly merged: boolean;
	/** What of theirs the edit replaced; empty when nothing competed. */
	readonly replaced: readonly Replaced[];
};

/** What `saveFile` wrote. */
type Written = {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: Uint8Array;
	readonly merged: boolean;
	readonly replaced: readonly Replaced[];
};

const encoder = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Every unit settles with the edit's side. */
const OURS = { kind: 'take', side: 'ours' } as const;

/** What a settled unit replaced of `theirs`, the file it was merged against. */
function replacedOf(unit: MergeUnit, theirs: CapturedFile): Replaced {
	switch (unit.kind) {
		case 'setting':
			return Object.freeze({
				kind: 'setting',
				key: unit.key,
				kept: unit.ours,
				theirs: unit.theirs,
			});
		case 'field':
			return Object.freeze({
				kind: 'field',
				field: unit.field,
				kept: unit.ours,
				theirs: unit.theirs,
			});
		case 'text':
			return Object.freeze({
				kind: 'text',
				part: unit.part,
				kept: unit.ours,
				theirs: unit.theirs,
				regions: Object.freeze(
					unit.regions.map((region) => Object.freeze(region)),
				),
			});
		case 'whole':
			return Object.freeze({ kind: 'whole', theirs });
	}
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
	let replaced: readonly Replaced[] = Object.freeze([]);
	for (let merges = 0; ; merges++) {
		const { data: saved, error: saveError } = await replaceCaptured(
			storage,
			fileCapture(path, expected),
			attempt,
		);
		if (saveError === null)
			return Ok(
				Object.freeze({
					path,
					sha256: saved.sha256,
					bytes: attempt,
					merged: merges > 0,
					replaced,
				}),
			);
		if (saveError.name !== 'Conflict' || !merge) return Err(saveError);
		if (merges === SAVE_MERGES)
			return TableError.KeptChanging({ path, attempts: SAVE_MERGES });
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
		const theirs: CapturedFile = Object.freeze({
			...fileCapture(path, current.sha256),
			bytes: current.bytes,
		});
		replaced = Object.freeze(
			merged.units.map((unit) => replacedOf(unit, theirs)),
		);
		attempt = bytes;
		expected = current.sha256;
	}
}

const toBytes = (content: FileContent) =>
	typeof content === 'string' ? encoder.encode(content) : content;

/** The text of a capture's content. */
function textOf(file: ContentCapture): string {
	return 'text' in file ? file.text : strict.decode(file.bytes);
}

/** `row` with each replaced field and its body set back to theirs. */
function withTheirFields(row: AnyRow, replaced: readonly Replaced[]): AnyRow {
	const fields = { ...row.fields };
	let { body } = row;
	for (const item of replaced) {
		if (item.kind === 'text' && item.part === 'body') body = item.theirs;
		if (item.kind === 'field') setField(fields, item.field, item.theirs);
	}
	return { fields, body };
}

/**
 * The one save that puts back what `saved` replaced of theirs, over the
 * version it wrote: their value in each field or setting, their side of
 * each text unit (the same merge with theirs winning where both changed the
 * same lines), or their whole file. Pass it to the save that wrote `saved`.
 *
 * A file saved through `files.save` at a row path or `kv.json` is restored
 * by field or key, which needs the folder's definition.
 */
export function restoreTheirs<TFields>(saved: SavedRow<TFields>): {
	readonly base: StoredRow<TFields>;
	readonly row: Row<TFields>;
};
export function restoreTheirs(
	saved: SavedFile,
	definition?: FolderDefinition,
): { readonly base: CapturedFile; readonly content: FileContent };
export function restoreTheirs(
	saved: SavedFile | SavedRow<Record<string, unknown>>,
	definition?: FolderDefinition,
):
	| { readonly base: CapturedFile; readonly content: FileContent }
	| {
			readonly base: StoredRow<Record<string, unknown>>;
			readonly row: AnyRow;
	  } {
	const { stored, replaced } = saved;
	if ('row' in stored)
		return { base: stored, row: withTheirFields(stored.row, replaced) };
	const file = stored as CapturedFile;
	const whole = replaced.find((item) => item.kind === 'whole');
	if (whole !== undefined) {
		if (whole.theirs === null)
			throw new Error('A save never replaces a file that is not there');
		return { base: file, content: whole.theirs.bytes };
	}
	const text = replaced.find(
		(item) => item.kind === 'text' && item.part === 'file',
	);
	if (text?.kind === 'text') return { base: file, content: text.theirs };
	const kind = fileKindOf(definition, file.path);
	const current = textOf(file);
	if (kind.kind === 'kv') {
		const members = new Map(readKvMembers(current));
		for (const item of replaced) {
			if (item.kind !== 'setting') continue;
			if (item.theirs === undefined) members.delete(item.key);
			else members.set(item.key, JSON.stringify(item.theirs));
		}
		return { base: file, content: formatKvMembers(members) };
	}
	if (kind.kind === 'row') {
		const { data: row, error } = parseRow(kind.table, current);
		if (error === null) {
			const restored = formatRow(
				kind.table,
				withTheirFields(row as AnyRow, replaced) as Parameters<
					typeof formatRow
				>[1],
			);
			if (restored.error === null)
				return { base: file, content: restored.data };
		}
	}
	if (replaced.length === 0) return { base: file, content: file.bytes };
	throw new Error(
		`Restoring ${file.path} by field or key needs the folder's definition`,
	);
}
