/**
 * File-backed tables: Markdown rows at `<table>/<stem>.md` (ADR-0457, ADR-0518).
 *
 * Every read goes through `parseRow` and every write through `formatRow`
 * (`row-text.ts`), so what a table writes it always reads back as the same
 * row. A read that found text is a `StoredRow`: the path and SHA-256 of the
 * bytes read, and the row they hold. Text that is not a valid row is
 * `InvalidRow`, which keeps the exact text and its hash for raw repair.
 *
 * Every write after `create` names the bytes it started from: a capture,
 * `{ path, sha256 }`. A `StoredRow`, an `InvalidRow`, or a listed row passes
 * as it is. `rename` and `delete` are refused as `Conflict` when the file no
 * longer holds those bytes, and nothing retries (ADR-0464). `save` merges
 * instead (ADR-0548): a file another writer changed is read again, merged
 * by field and the body by line, and written over its current bytes, so
 * every app, script, and agent saves the same way. Its compare-and-swap is
 * the engine's internal step. `create` alone is unconditional, and refuses
 * an occupied stem. The hash is a condition on bytes, not an identity or a
 * revision.
 *
 * A table reads and writes exactly one Markdown file per row (ADR-0480). A
 * sibling that shares a row's stem is an ordinary file: it is not part of the
 * row, it does not block creating the row, and renaming or deleting the row
 * leaves it where it is.
 */

import { customAlphabet } from 'nanoid';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import {
	type FileCapture,
	fileCapture,
	hashBytes,
	ownCapture,
	submittedText,
} from './capture.js';
import type { PreparedFolderTable } from './definition.js';
import {
	FileError,
	type RowReadError,
	type TableCreateError,
	type TableDeleteError,
	type TableEnumerationError,
	TableError,
	type TableRenameError,
	type TableSaveError,
} from './errors.js';
import { mergeLinesPreferring } from './git/merge-lines.js';
import {
	ROW_EXTENSION,
	rowAddressProblem,
	rowPath,
	rowStemOf,
} from './paths.js';
import { type AnyRow, mergeRow, type RowMerge } from './row-merge.js';
import { formatRow, parseRow, type Row, writeRow } from './row-text.js';
import { applyOne, replaceCaptured } from './storage.js';

/**
 * One read of a row file: which bytes were read, and the row they hold. The
 * capture never changes; `row` is the caller's own to edit and save.
 */
export type StoredRow<TFields> = {
	readonly path: string;
	readonly sha256: string;
	readonly row: Row<TFields>;
};

/**
 * One item for every `.md` name directly in the table's directory, in no
 * promised order, each read through the same pipeline as `get`. A symbolic
 * link is that item's `InvalidPath` and a directory its `NotAFile`. A file
 * that went away after it was enumerated is that item's `NotFound`.
 */
export type TableListing<TFields> = readonly {
	readonly stem: string;
	readonly result: Result<StoredRow<TFields>, RowReadError>;
}[];

/**
 * One value of another writer's that a save replaced, because both changed
 * it, with what a person needs to put theirs back: save the stored row with
 * `theirs` where the edit's `kept` stands.
 *
 * - `field`: both changed `field`. `kept` is the value saved, `theirs`
 *   theirs; `undefined` on either side is no such field.
 * - `body`: both changed the same body lines. `kept` is the edit's lines,
 *   standing in the saved body from the 0-based `line`, and `theirs` the
 *   lines they replaced. Lines end with their line feeds.
 */
export type Replaced =
	| {
			readonly kind: 'field';
			readonly field: string;
			readonly kept: unknown;
			readonly theirs: unknown;
	  }
	| {
			readonly kind: 'body';
			readonly line: number;
			readonly kept: string;
			readonly theirs: string;
	  };

/** A save that landed. */
export type SavedRow<TFields> = {
	/** The row as written, and the capture of the bytes it was written as. */
	readonly stored: StoredRow<TFields>;
	/**
	 * Whether another writer changed the file since the capture, so the edit
	 * was merged with their change before it was written.
	 */
	readonly merged: boolean;
	/** What of theirs the edit replaced; empty when nothing competed. */
	readonly replaced: readonly Replaced[];
};

/** How many times a save merges with a newer file before it gives up. */
export const SAVE_MERGES = 3;

export type FileTable<TFields> = {
	readonly name: string;
	/**
	 * Whether `create` can add a row. False only for a table opened through a
	 * lens that does not declare every field the folder requires (ADR-0538):
	 * its rows can be read and saved, and `create` is `CannotCreate`.
	 */
	readonly canCreate: boolean;
	/** An outer error means the listing itself failed; no partial listing is returned. */
	list(): Promise<Result<TableListing<TFields>, TableEnumerationError>>;
	/** `undefined` only when no file is at the stem. */
	get(
		stem: string,
	): Promise<Result<StoredRow<TFields> | undefined, RowReadError>>;
	/**
	 * Save a new row at `stem`, or a generated stem. The row must be valid:
	 * a value that does not conform or cannot be written is `InvalidValues`,
	 * and nothing is published. Unknown keys are kept. Refused as `Exists`
	 * when a file is at the path, and as `CannotCreate` when `canCreate` is
	 * false.
	 */
	create(
		row: Row<TFields>,
		options?: { readonly stem?: string },
	): Promise<Result<StoredRow<TFields>, TableCreateError>>;
	/**
	 * Save an edit of the captured row file (ADR-0548). When the file still
	 * holds the captured bytes, `row` is written over them. Otherwise another
	 * writer changed it: the current file is read and merged with the edit,
	 * field by field and the body by line, with the edit winning only where
	 * both changed the same field or the same lines, and the merge is written
	 * over the current bytes. That repeats at most `SAVE_MERGES` times.
	 *
	 * The base of the merge is the row the captured bytes held. A `StoredRow`
	 * this table returned (from `get`, `list`, `create`, or `save`) knows it,
	 * even if its `row` was edited in place since. Any other capture with a
	 * `row` is taken to carry the row as those bytes held it, before the
	 * edit. A capture without one (an `InvalidRow` being repaired, or a bare
	 * `{ path, sha256 }`) has no base, so every field and line the two sides
	 * hold differently is the edit's, and is reported in `replaced`.
	 *
	 * Fails, writing nothing, when `row` does not conform or cannot be
	 * written (`InvalidValues`), the file was deleted (`NotFound`; a save
	 * never recreates a row), another writer left text that is not a row
	 * (`InvalidRow`, `InvalidUtf8`), or the file kept changing
	 * (`KeptChanging`).
	 */
	save(
		file: FileCapture & { readonly row?: Row<TFields> },
		row: Row<TFields>,
	): Promise<Result<SavedRow<TFields>, TableSaveError>>;
	/**
	 * Move the captured row file to a vacant stem, guarded by its bytes. The
	 * returned capture is those bytes at the new path, not a read of it.
	 */
	rename(
		file: FileCapture,
		nextStem: string,
	): Promise<Result<FileCapture, TableRenameError>>;
	/** Remove the captured row file, guarded by its bytes. */
	delete(file: FileCapture): Promise<Result<undefined, TableDeleteError>>;
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const generateStem = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

function decode(bytes: Uint8Array): string | undefined {
	try {
		return utf8.decode(bytes);
	} catch {
		return undefined;
	}
}

/**
 * The file table for one declared table. `name` is its key in the prepared
 * definition and its directory; `table` is its prepared definition, which
 * every read and write is checked against. `unsupplied` lists the fields
 * `table` requires that the caller's lens does not declare; when there are
 * any, `create` refuses.
 */
export function createTable<TFields>(
	{ storage }: { storage: FolderStorage },
	name: string,
	table: PreparedFolderTable,
	unsupplied: readonly string[] = [],
): FileTable<TFields> {
	/** The row path a literal stem addresses, or why it is not one filename segment here. */
	function rowAddress(
		stem: string,
	): Result<string, Extract<FileError, { name: 'InvalidPath' }>> {
		const problem = rowAddressProblem(name, stem);
		if (problem !== undefined)
			return FileError.InvalidPath({
				path: rowPath(name, String(stem)),
				reason: problem,
			});
		return Ok(rowPath(name, stem));
	}

	/** The caller's capture, owned before anything is awaited, if it is a row file of this table. */
	function ownRowCapture(
		file: FileCapture,
	): Result<FileCapture, Extract<FileError, { name: 'InvalidPath' }>> {
		const { data: captured, error } = ownCapture(file);
		if (error !== null) return Err(error);
		if (rowStemOf(name, captured.path) === undefined)
			return FileError.InvalidPath({
				path: captured.path,
				reason: `not a row file of the '${name}' table`,
			});
		return Ok(captured);
	}

	/** Read the text of one read's bytes as a row. */
	function storedRow(
		path: string,
		read: { bytes: Uint8Array; sha256: string },
	): Result<StoredRow<TFields>, RowReadError> {
		const { sha256 } = read;
		const text = decode(read.bytes);
		if (text === undefined) return TableError.InvalidUtf8({ path, sha256 });
		const { data: row, error: issues } = parseRow(table, text);
		if (issues !== null)
			return TableError.InvalidRow({ path, sha256, text, issues });
		return Ok(issued({ path, sha256, row: row as Row<TFields> }, text));
	}

	/**
	 * The exact bytes a valid row is saved as, and the row they read back
	 * as, prepared synchronously so later changes to the row change nothing.
	 */
	function prepare(
		row: Row<TFields>,
	): Result<
		{ bytes: Uint8Array; text: string; row: Row<TFields> },
		Extract<TableError, { name: 'InvalidValues' }>
	> {
		const { data: written, error: issues } = writeRow(
			table,
			row as Parameters<typeof writeRow>[1],
		);
		if (issues !== null) return TableError.InvalidValues({ issues });
		const { bytes, text } = submittedText(written.text);
		return Ok({ bytes, text, row: written.row as Row<TFields> });
	}

	/**
	 * The text of each row this table read or wrote, by the `StoredRow` it
	 * returned: what those bytes held, whatever the caller did to its row.
	 */
	const issuedText = new WeakMap<object, string>();

	function issued(
		stored: StoredRow<TFields>,
		text: string,
	): StoredRow<TFields> {
		const frozen = Object.freeze(stored);
		issuedText.set(frozen, text);
		return frozen;
	}

	/**
	 * The text of the row a save started from, or `null` for no base. A
	 * `StoredRow` this table returned is its own record, so an edit made to
	 * its row in place is still the edit; another capture's `row` is taken
	 * as the row its bytes held. A capture without one, or a row that is not
	 * a row of this table, has no base: nothing can tell which side changed
	 * what.
	 */
	function baseText(
		file: FileCapture & { readonly row?: Row<TFields> },
	): string | null {
		const recorded = issuedText.get(file);
		if (recorded !== undefined) return recorded;
		const { row } = file;
		if (row === undefined) return null;
		const { data: text, error } = formatRow(
			table,
			row as Parameters<typeof formatRow>[1],
		);
		if (error !== null) return null;
		return parseRow(table, text).error === null ? text : null;
	}

	/**
	 * Every name directly in the table's directory; none when it does not exist
	 * yet. A directory named like a row is included so reading reports it.
	 */
	async function filenamesOf(): Promise<
		Result<string[], TableEnumerationError>
	> {
		const { data: children, error } = await storage.children(name);
		if (error !== null) return error.name === 'NotFound' ? Ok([]) : Err(error);
		return Ok([...children.files, ...children.directories].sort());
	}

	return {
		name,
		canCreate: unsupplied.length === 0,
		async list() {
			const { data: filenames, error: listError } = await filenamesOf();
			if (listError !== null) return Err(listError);
			// Only the exact lowercase extension is a row; `a.MD` is an ordinary file.
			const rows = filenames.filter((file) => file.endsWith(ROW_EXTENSION));
			const { data: reads, error: readsError } = await storage.readMany(
				rows.map((file) => `${name}/${file}`),
			);
			if (readsError !== null) return Err(readsError);
			return Ok(
				Object.freeze(
					rows.map((file) => {
						const path = `${name}/${file}`;
						const stem = file.slice(0, -ROW_EXTENSION.length);
						const outcome = reads.get(path);
						if (outcome === undefined)
							return Object.freeze({
								stem,
								result: FileError.Io({
									path,
									operation: 'read',
									cause: 'The storage response omitted this requested file',
								}),
							});
						return Object.freeze({
							stem,
							result:
								outcome.error !== null
									? Err(outcome.error)
									: storedRow(path, outcome.data),
						});
					}),
				),
			);
		},
		async get(stem) {
			const { data: path, error: addressError } = rowAddress(stem);
			if (addressError !== null) return Err(addressError);
			const { data: read, error: readError } = await storage.read(path);
			if (readError !== null)
				return readError.name === 'NotFound' ? Ok(undefined) : Err(readError);
			return storedRow(path, read);
		},
		async create(row, options) {
			if (unsupplied.length > 0)
				return TableError.CannotCreate({ table: name, fields: unsupplied });
			const { data: path, error: addressError } = rowAddress(
				options?.stem ?? generateStem(),
			);
			if (addressError !== null) return Err(addressError);
			const { data: prepared, error: prepareError } = prepare(row);
			if (prepareError !== null) return Err(prepareError);
			const sha256 = await hashBytes(prepared.bytes);
			const { error: applyError } = await applyOne(storage, {
				kind: 'create',
				path,
				bytes: prepared.bytes,
				sha256,
			});
			if (applyError !== null) return Err(applyError);
			return Ok(issued({ path, sha256, row: prepared.row }, prepared.text));
		},
		async save(file, row) {
			const { data: captured, error: captureError } = ownRowCapture(file);
			if (captureError !== null) return Err(captureError);
			// The base and the edit are owned as text before anything is
			// awaited, so later changes to either change nothing.
			const base = baseText(file);
			const { data: edit, error: prepareError } = prepare(row);
			if (prepareError !== null) return Err(prepareError);
			let capture = captured;
			let attempt = edit;
			let mergeBase = base;
			const replaced: Replaced[] = [];
			for (let merges = 0; ; merges++) {
				const { data: saved, error: saveError } = await replaceCaptured(
					storage,
					capture,
					attempt.bytes,
				);
				if (saveError === null)
					return Ok(
						Object.freeze({
							stored: issued({ ...saved, row: attempt.row }, attempt.text),
							merged: merges > 0,
							replaced: Object.freeze(replaced),
						}),
					);
				if (saveError.name !== 'Conflict') return Err(saveError);
				if (merges === SAVE_MERGES)
					return TableError.KeptChanging({
						path: capture.path,
						attempts: SAVE_MERGES,
					});
				const { data: read, error: readError } = await storage.read(
					capture.path,
				);
				if (readError !== null) return Err(readError);
				const { data: current, error: currentError } = storedRow(
					capture.path,
					read,
				);
				if (currentError !== null) return Err(currentError);
				// The current file read as a row, so its text decodes.
				const theirs = decode(read.bytes) as string;
				const settled = await editWins(
					await mergeRow(table, {
						base: mergeBase,
						ours: attempt.text,
						theirs,
					}),
				);
				const { data: merged, error: mergedError } = prepare(
					settled.row as Row<TFields>,
				);
				if (mergedError !== null) return Err(mergedError);
				// What earlier merges replaced may stand elsewhere in this body.
				replaced.splice(
					0,
					replaced.length,
					...replaced.map((entry) => relocate(merged.row.body, entry)),
					...settled.replaced,
				);
				capture = fileCapture(current.path, current.sha256);
				attempt = merged;
				mergeBase = theirs;
			}
		},
		async rename(file, nextStem) {
			const { data: captured, error: captureError } = ownRowCapture(file);
			if (captureError !== null) return Err(captureError);
			const { data: to, error: toError } = rowAddress(nextStem);
			if (toError !== null) return Err(toError);
			// A move to its own path would check neither the row nor its bytes,
			// so success would claim what nothing verified.
			if (to === captured.path)
				return FileError.InvalidPath({
					path: to,
					reason: 'A row cannot be renamed to the stem it already has',
				});
			const { error: moveError } = await applyOne(storage, {
				kind: 'move',
				from: captured.path,
				to,
				expectedSha256: captured.sha256,
			});
			if (moveError !== null) return Err(moveError);
			return Ok(fileCapture(to, captured.sha256));
		},
		async delete(file) {
			const { data: captured, error: captureError } = ownRowCapture(file);
			if (captureError !== null) return Err(captureError);
			return applyOne(storage, {
				kind: 'remove',
				path: captured.path,
				expectedSha256: captured.sha256,
			});
		},
	};
}

/**
 * The merged row with every competing field and every competing body region
 * taken from the edit, and what of theirs that replaced. Body lines only
 * theirs changed stay theirs.
 */
async function editWins(
	merge: RowMerge,
): Promise<{ row: AnyRow; replaced: Replaced[] }> {
	// The edit was written and the current file read as a row, and a base
	// that is not a row is passed as none, so every version reads as a row.
	if (merge.kind === 'whole')
		throw new Error('A save merged versions that do not all read as rows');
	const row: AnyRow = { fields: { ...merge.row.fields }, body: merge.row.body };
	if (merge.kind === 'merged') return { row, replaced: [] };
	const replaced: Replaced[] = [];
	for (const conflict of merge.fields) {
		// The edit leaving a field out removes it, which the merged row already does.
		if (conflict.ours !== undefined)
			Object.defineProperty(row.fields, conflict.field, {
				value: conflict.ours,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		replaced.push({
			kind: 'field',
			field: conflict.field,
			kept: conflict.ours,
			theirs: conflict.theirs,
		});
	}
	if (merge.body !== undefined) {
		// Merged by line again, with the edit taking only the competing regions.
		const body = await mergeLinesPreferring(
			{
				base: merge.body.base ?? '',
				ours: merge.body.ours,
				theirs: merge.body.theirs,
			},
			'ours',
		);
		row.body = body.text;
		for (const region of body.replaced)
			replaced.push({
				kind: 'body',
				line: region.line,
				kept: region.kept,
				theirs: region.lost,
			});
	}
	return { row, replaced };
}

/**
 * Where a body region an earlier merge reported stands in `body`, the text
 * a later merge produced: the run of its kept lines nearest where it stood.
 * A region whose lines are gone, or that kept no lines, keeps its line.
 */
function relocate(body: string, replaced: Replaced): Replaced {
	if (replaced.kind !== 'body' || replaced.kept === '') return replaced;
	const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const kept = replaced.kept.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let best: number | undefined;
	for (let at = 0; at + kept.length <= lines.length; at++)
		if (
			kept.every((line, index) => lines[at + index] === line) &&
			(best === undefined ||
				Math.abs(at - replaced.line) < Math.abs(best - replaced.line))
		)
			best = at;
	return best === undefined ? replaced : { ...replaced, line: best };
}
