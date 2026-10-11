/**
 * File-backed tables: Markdown rows at `<table>/<stem>.md` (ADR-0457, ADR-0518).
 *
 * Every read goes through `parseRow` and every write through `formatRow`
 * (`row-text.ts`), so what a table writes it always reads back as the same
 * row. A read that found text is a `StoredRow`: the path and SHA-256 of the
 * bytes read, and the row they hold. Text that is not a valid row is
 * `InvalidRow`, which keeps the exact text and its hash for raw repair.
 *
 * Every write after `create` names the bytes it replaces. `replace`,
 * `rename`, and `delete` take a capture, `{ path, sha256 }`: a `StoredRow`,
 * an `InvalidRow`, or a listed row passes as it is. The change is refused as
 * `Conflict` when the file no longer holds those bytes, and nothing retries
 * (ADR-0464). `create` alone is unconditional, and refuses an occupied stem.
 * An editing session saves through `autosave`: the caller owns the row,
 * each request is prepared before it returns, one write runs at a time with
 * only the latest request waiting, and each write is guarded by the bytes
 * the previous one saved.
 * The hash is a condition on bytes, not an identity or a revision.
 *
 * A table reads and writes exactly one Markdown file per row (ADR-0480). A
 * sibling that shares a row's stem is an ordinary file: it is not part of the
 * row, it does not block creating the row, and renaming or deleting the row
 * leaves it where it is.
 */

import { customAlphabet } from 'nanoid';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type Autosave, createAutosave, type SaveState } from './autosave.js';
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
	type RowSaveError,
	type TableCreateError,
	type TableDeleteError,
	type TableEnumerationError,
	TableError,
	type TableRenameError,
	type TableReplaceError,
} from './errors.js';
import {
	ROW_EXTENSION,
	rowAddressProblem,
	rowPath,
	rowStemOf,
} from './paths.js';
import { mergeRow, type RowMerge } from './row-merge.js';
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

export type FileTable<TFields> = {
	readonly name: string;
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
	 * when a file is at the path.
	 */
	create(
		row: Row<TFields>,
		options?: { readonly stem?: string },
	): Promise<Result<StoredRow<TFields>, TableCreateError>>;
	/**
	 * Save a valid row over the captured row file, guarded by its bytes. A
	 * missing file or different bytes is `Conflict`; a row that does not
	 * conform or cannot be written is `InvalidValues`.
	 */
	replace(
		file: FileCapture,
		row: Row<TFields>,
	): Promise<Result<StoredRow<TFields>, TableReplaceError>>;
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
	/**
	 * Save one editing session's row over the captured row file. Each
	 * `request(row)` is prepared before it returns: a row that is not valid,
	 * or that cannot be written, is that request's `InvalidValues` at once and
	 * is never written, so the session's draft stays the caller's to fix. Each
	 * write is guarded by the bytes the previous one saved, starting from the
	 * capture; a change made elsewhere, or a deleted row, is `Conflict`.
	 * `saved` carries the capture of the bytes now in the file. Construction
	 * reads, writes, and reports nothing.
	 */
	autosave(
		file: FileCapture,
		options: { onState(state: SaveState<RowSaveError>): void },
	): Autosave<Row<TFields>, RowSaveError>;
	/**
	 * Merge three versions of one row by field and body, as sync does
	 * (ADR-0514): equal values agree, a side unchanged from `base` yields to
	 * the other, and the body merges by line. A version that cannot be
	 * written, or does not read back as a row of this table, makes the whole
	 * row one unit. Writes nothing.
	 */
	merge(versions: {
		readonly base: Row<TFields>;
		readonly ours: Row<TFields>;
		readonly theirs: Row<TFields>;
	}): Promise<RowMerge>;
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
 * definition and its directory; `table` is its prepared definition.
 */
export function createTable<TFields>(
	{ storage }: { storage: FolderStorage },
	name: string,
	table: PreparedFolderTable,
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
		return Ok(Object.freeze({ path, sha256, row: row as Row<TFields> }));
	}

	/**
	 * The exact bytes a valid row is saved as, and the row they read back
	 * as, prepared synchronously so later changes to the row change nothing.
	 */
	function prepare(
		row: Row<TFields>,
	): Result<
		{ bytes: Uint8Array; row: Row<TFields> },
		Extract<TableError, { name: 'InvalidValues' }>
	> {
		const { data: written, error: issues } = writeRow(
			table,
			row as Parameters<typeof writeRow>[1],
		);
		if (issues !== null) return TableError.InvalidValues({ issues });
		return Ok({
			bytes: submittedText(written.text).bytes,
			row: written.row as Row<TFields>,
		});
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
			return Ok(Object.freeze({ path, sha256, row: prepared.row }));
		},
		async replace(file, row) {
			const { data: captured, error: captureError } = ownRowCapture(file);
			if (captureError !== null) return Err(captureError);
			const { data: prepared, error: prepareError } = prepare(row);
			if (prepareError !== null) return Err(prepareError);
			const { data: saved, error: saveError } = await replaceCaptured(
				storage,
				captured,
				prepared.bytes,
			);
			if (saveError !== null) return Err(saveError);
			return Ok(Object.freeze({ ...saved, row: prepared.row }));
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
		autosave(file, { onState }) {
			const owned = ownRowCapture(file);
			return createAutosave({
				file: owned.data ?? file,
				prepare(row: Row<TFields>) {
					if (owned.error !== null) return Err(owned.error);
					return prepare(row);
				},
				write: ({ bytes }, over) => replaceCaptured(storage, over, bytes),
				onState,
			});
		},
		async merge({ base, ours, theirs }) {
			const text = (row: Row<TFields>) => {
				const { data, error } = formatRow(table, row as never);
				return error === null ? data : undefined;
			};
			const [b, o, t] = [text(base), text(ours), text(theirs)];
			if (b === undefined || o === undefined || t === undefined)
				return { kind: 'whole' };
			return mergeRow(table, { base: b, ours: o, theirs: t });
		},
	};
}
