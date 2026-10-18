/**
 * File-backed tables: Markdown rows at `<table>/<stem>.md` (ADR-0457,
 * ADR-0518), as typed views over the one write (ADR-0576).
 *
 * Every read goes through `parseRow`. A read that found text is a
 * `StoredRow`: the path and SHA-256 of the bytes read, their exact text,
 * and the row they hold. Text that is not a valid row is `InvalidRow`, which
 * keeps the exact text and its hash for raw repair.
 *
 * Every change of a row's content is `write(stem, from, to)`: the change
 * from the row `from` to the row `to`, merged into the file as it is now by
 * field and the body by line, the writer winning a unit both changed, and
 * written in canonical form. The helpers build the change and call it:
 *
 * | Helper | `from` |
 * | --- | --- |
 * | `set(stem, fields)` | the row as it is now |
 * | `create(row)` | no file: placed only where none is |
 * | `delete(stem)` | none: the deleter wins |
 *
 * `rename(stem, next)` changes where a file is, not what it holds, so it is
 * not a write: it is `folder.move` between the two row paths, which puts the
 * bytes at `next` only where nothing is and removes `stem` only while it
 * holds them.
 *
 * A table reads and writes exactly one Markdown file per row (ADR-0480). A
 * sibling that shares a row's stem is an ordinary file: it is not part of the
 * row, it does not block creating the row, and renaming or deleting the row
 * leaves it where it is.
 */

import { customAlphabet } from 'nanoid';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import type { PreparedFolderTable } from './definition.js';
import {
	FileError,
	RowReadError,
	RowWriteError,
	type WriteError,
} from './errors.js';
import type { FileContent } from './merge-file.js';
import { rowAddressProblem, rowPath, rowStemOfName } from './paths.js';
import { sameValue } from './row-merge.js';
import { parseRow, type Row, writeRow } from './row-text.js';
import { movePath, writeFailure, writeFile } from './write.js';

/**
 * One read or write of a row file: which bytes, their exact text, and the
 * row they hold. `row` is the caller's to edit; the capture never changes.
 */
export type StoredRow<TFields> = {
	readonly path: string;
	readonly sha256: string;
	readonly text: string;
	readonly row: Row<TFields>;
};

/**
 * One item for every row file directly in the table's directory
 * (`rowStemOfName`), in no promised order, each read through the same
 * pipeline as `get`. A directory is never a row, whatever its name. A
 * symbolic link or special entry under a row's name is that item's
 * `InvalidPath`, and a file that went away after it was enumerated is that
 * item's `NotFound`.
 */
export type TableListing<TFields> = readonly {
	readonly stem: string;
	readonly result: Result<StoredRow<TFields>, RowReadError>;
}[];

/**
 * A file at a row's path that does not read as a row: what `get` answers
 * for it, held as a value.
 */
export type UnreadableRow = Extract<
	RowReadError,
	{ name: 'InvalidRow' | 'InvalidUtf8' }
>;

/**
 * What a row write leaves at its stem: the row; the file, when the write
 * merged into a file that does not read as a row and left it to repair
 * (ADR-0503); or `null` when no file is there, because the write deleted it
 * or found it deleted.
 */
export type WrittenRow<TFields> = StoredRow<TFields> | UnreadableRow | null;

/** Whether a row write left a row that reads as one. */
export const isStoredRow = <TFields>(
	written: WrittenRow<TFields>,
): written is StoredRow<TFields> => written !== null && 'row' in written;

export type FileTable<TFields> = {
	readonly name: string;
	/**
	 * Whether `create` can add a row. False only for a table read through a
	 * definition that does not declare every field the folder requires
	 * (ADR-0538):
	 * its rows can be read and written, and `create` is `InvalidValues`.
	 */
	readonly canCreate: boolean;
	/** An outer error means the listing itself failed; no partial listing is returned. */
	list(): Promise<Result<TableListing<TFields>, FileError>>;
	/** `undefined` only when no file is at the stem. */
	get(
		stem: string,
	): Promise<Result<StoredRow<TFields> | undefined, RowReadError>>;
	/**
	 * Write the change from `from` to `to` into the row at `stem` as it is
	 * now (`folder.write`, ADR-0576): `null` for no row on either side.
	 * Fields and body lines only one side changed survive; where both
	 * changed one, this write wins. A row that cannot be written is
	 * `InvalidValues`, and nothing is written.
	 */
	write(
		stem: string,
		from: Row<TFields> | null,
		to: Row<TFields> | null,
	): Promise<Result<WrittenRow<TFields>, RowWriteError>>;
	/**
	 * Set fields of the row at `stem` as it is now: every field it does not
	 * name keeps its value, and a field set to `undefined` is removed. A row
	 * that is not there is not made: `null`, and nothing is written. A file
	 * that does not read as a row has no fields to set: `InvalidValues`.
	 */
	set(
		stem: string,
		fields: Partial<TFields>,
	): Promise<Result<WrittenRow<TFields>, RowWriteError>>;
	/**
	 * Add `row` at `stem`, or a generated stem. A file already at `stem` is
	 * `Occupied`, unless it holds this row's exact text, which is this
	 * create landed before. A row that cannot be written is `InvalidValues`.
	 */
	create(
		row: Row<TFields>,
		options?: { readonly stem?: string },
	): Promise<Result<WrittenRow<TFields>, RowWriteError>>;
	/** Delete the row at `stem`, whatever it holds now. */
	delete(stem: string): Promise<Result<undefined, WriteError>>;
	/**
	 * Move the row file at `stem` to `next`, as it is: its bytes land at
	 * `next` only where nothing is, then `stem` is removed only while it
	 * holds them. A write that lands at `stem` meanwhile is carried to `next`
	 * first. No file at `stem` is `InvalidPath`, and one already at `next`
	 * `Occupied`; either stem changing on every attempt is `KeptChanging`, and both stems
	 * then hold the row, as they do when the removal fails.
	 */
	rename(
		stem: string,
		next: string,
	): Promise<Result<WrittenRow<TFields>, WriteError>>;
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
 * `table` requires that the definition the caller reads through does not
 * declare; when there are any, `create` refuses.
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

	/** Read the text of one read's bytes as a row. */
	function storedRow(
		path: string,
		read: { bytes: Uint8Array; sha256: string },
	): Result<StoredRow<TFields>, RowReadError> {
		const { sha256 } = read;
		const text = decode(read.bytes);
		if (text === undefined) return RowReadError.InvalidUtf8({ path, sha256 });
		const { data: row, error: issues } = parseRow(table, text);
		if (issues !== null)
			return RowReadError.InvalidRow({ path, sha256, text, issues });
		return Ok(Object.freeze({ path, sha256, text, row: row as Row<TFields> }));
	}

	/** What a write left at `path`, read as a row. */
	function readBack(
		path: string,
		file: { bytes: Uint8Array; sha256: string },
	): StoredRow<TFields> | UnreadableRow {
		const stored = storedRow(path, file);
		if (stored.error === null) return stored.data;
		// A written file was read, so its failure is about its text.
		return stored.error as UnreadableRow;
	}

	/** The canonical text of a valid row, or why it cannot be written. */
	function textOf(row: Row<TFields>): Result<string, RowWriteError> {
		const { data: written, error: issues } = writeRow(
			table,
			row as Parameters<typeof writeRow>[1],
		);
		if (issues !== null) return RowWriteError.InvalidValues({ issues });
		return Ok(written.text);
	}

	/**
	 * What `write`'s change starts from: the file as it is now when it holds
	 * the row `from` names, in whatever spelling, so the file's own spelling
	 * is the base and not an edit the merge would keep (ADR-0572: a row
	 * written from an app is in standard form); otherwise `from` as written.
	 */
	async function baseOf(path: string, from: string): Promise<FileContent> {
		const { data: read, error } = await storage.read(path);
		if (error !== null) return from;
		let text: string;
		try {
			text = utf8.decode(read.bytes);
		} catch {
			return from;
		}
		const [now, was] = [parseRow(table, text), parseRow(table, from)];
		return now.error === null &&
			was.error === null &&
			now.data.body === was.data.body &&
			sameValue(now.data.fields, was.data.fields)
			? read.bytes
			: from;
	}

	/** The one write of the file at `path`, and the row it left there. */
	async function written(
		path: string,
		from: FileContent | null,
		to: FileContent | null,
	): Promise<Result<WrittenRow<TFields>, WriteError>> {
		const { data, error } = await writeFile(storage, path, from, to);
		if (error !== null) return Err(error);
		if (data.file === null) return Ok(null);
		return Ok(readBack(path, data.file));
	}

	/**
	 * The name of every entry directly in the table's directory that is not
	 * a directory; none when the directory does not exist yet.
	 */
	async function filenamesOf(): Promise<Result<string[], FileError>> {
		const { data: children, error } = await storage.children(name);
		if (error !== null) return error.name === 'NotFound' ? Ok([]) : Err(error);
		return Ok([...children.files].sort());
	}

	const fileTable: FileTable<TFields> = {
		name,
		canCreate: unsupplied.length === 0,
		async list() {
			const { data: filenames, error: listError } = await filenamesOf();
			if (listError !== null) return Err(listError);
			const rows: TableListing<TFields>[number][] = [];
			for (const file of filenames) {
				// The one row predicate: `a.MD`, `.md`, and `.hidden.md` are ordinary files.
				const stem = rowStemOfName(file);
				if (stem === undefined) continue;
				const path = rowPath(name, stem);
				const read = await storage.read(path);
				rows.push(
					Object.freeze({
						stem,
						result:
							read.error !== null
								? Err(read.error)
								: storedRow(path, read.data),
					}),
				);
			}
			return Ok(Object.freeze(rows));
		},
		async get(stem) {
			const { data: path, error: addressError } = rowAddress(stem);
			if (addressError !== null) return Err(addressError);
			const { data: read, error: readError } = await storage.read(path);
			if (readError !== null)
				return readError.name === 'NotFound' ? Ok(undefined) : Err(readError);
			return storedRow(path, read);
		},
		async write(stem, from, to) {
			const { data: path, error: addressError } = rowAddress(stem);
			if (addressError !== null) return Err(addressError);
			// Both owned before anything is awaited.
			const base = from === null ? Ok(null) : textOf(from);
			if (base.error !== null) return Err(base.error);
			const next = to === null ? Ok(null) : textOf(to);
			if (next.error !== null) return Err(next.error);
			// A write that changes nothing leaves the file as it is.
			return written(
				path,
				base.data === null || base.data === next.data
					? base.data
					: await baseOf(path, base.data),
				next.data,
			);
		},
		async set(stem, fields) {
			const { data: current, error: readError } = await fileTable.get(stem);
			if (readError !== null)
				return readError.name === 'InvalidRow'
					? RowWriteError.InvalidValues({ issues: readError.issues })
					: readError.name === 'InvalidUtf8'
						? RowWriteError.InvalidValues({
								issues: [{ message: readError.message }],
							})
						: Err(writeFailure(rowPath(name, stem), readError));
			if (current === undefined) return Ok(null);
			const merged: Record<string, unknown> = {
				...current.row.fields,
				...fields,
			};
			for (const [field, value] of Object.entries(fields))
				if (value === undefined) delete merged[field];
			const next = textOf({
				fields: merged as Row<TFields>['fields'],
				body: current.row.body,
			});
			if (next.error !== null) return Err(next.error);
			return written(rowPath(name, stem), current.text, next.data);
		},
		async create(row, options) {
			if (unsupplied.length > 0)
				return RowWriteError.InvalidValues({
					issues: unsupplied.map((field) => ({
						message: `The folder requires '${name}.${field}' in every row, which this app's definition does not declare, so it cannot add rows`,
						field,
					})),
				});
			return fileTable.write(options?.stem ?? generateStem(), null, row);
		},
		async delete(stem) {
			const { data: path, error: addressError } = rowAddress(stem);
			if (addressError !== null) return Err(addressError);
			const { error } = await writeFile(storage, path, null, null);
			return error === null ? Ok(undefined) : Err(error);
		},
		async rename(stem, next) {
			const { data: from, error: fromError } = rowAddress(stem);
			if (fromError !== null) return Err(fromError);
			const { data: to, error: toError } = rowAddress(next);
			if (toError !== null) return Err(toError);
			const { data: moved, error } = await movePath(storage, from, to);
			if (error !== null) return Err(error);
			return Ok(moved.file === null ? null : readBack(to, moved.file));
		},
	};
	return fileTable;
}
