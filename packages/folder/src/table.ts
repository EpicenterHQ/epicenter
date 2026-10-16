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
 * not a write: its bytes are put at `next` only where nothing is, and `stem`
 * is removed only while it holds them.
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
	type RowReadError,
	type TableEnumerationError,
	TableError,
	WriteError,
} from './errors.js';
import type { FileContent } from './merge-file.js';
import { ROW_EXTENSION, rowAddressProblem, rowPath } from './paths.js';
import { parseRow, type Row, writeRow } from './row-text.js';
import {
	confirmedPut,
	WRITE_ATTEMPTS,
	writeFailure,
	writeFile,
} from './save-file.js';
import { readMany } from './storage.js';

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
	 * Whether `create` can add a row. False only for a table opened through a
	 * lens that does not declare every field the folder requires (ADR-0538):
	 * its rows can be read and written, and `create` is `InvalidValues`.
	 */
	readonly canCreate: boolean;
	/** An outer error means the listing itself failed; no partial listing is returned. */
	list(): Promise<Result<TableListing<TFields>, TableEnumerationError>>;
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
	): Promise<Result<WrittenRow<TFields>, WriteError>>;
	/**
	 * Set fields of the row at `stem` as it is now: every field it does not
	 * name keeps its value, and a field set to `undefined` is removed. A row
	 * that is not there is not made: `null`, and nothing is written. A file
	 * that does not read as a row has no fields to set: `InvalidValues`.
	 */
	set(
		stem: string,
		fields: Partial<TFields>,
	): Promise<Result<WrittenRow<TFields>, WriteError>>;
	/**
	 * Add `row` at `stem`, or a generated stem. A file already at `stem` is
	 * `InvalidPath`, unless it holds this row's exact text, which is this
	 * create landed before. A row that cannot be written is `InvalidValues`.
	 */
	create(
		row: Row<TFields>,
		options?: { readonly stem?: string },
	): Promise<Result<WrittenRow<TFields>, WriteError>>;
	/** Delete the row at `stem`, whatever it holds now. */
	delete(stem: string): Promise<Result<undefined, WriteError>>;
	/**
	 * Move the row file at `stem` to `next`, as it is: its bytes land at
	 * `next` only where nothing is, then `stem` is removed only while it
	 * holds them. A write that lands at `stem` meanwhile is carried to `next`
	 * first. No file at `stem`, or one already at `next`, is `InvalidPath`;
	 * either stem changing on every attempt is `KeptChanging`, and both stems
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
 * `table` requires that the caller's lens does not declare; when there are
 * any, `create` refuses.
 */
export function createTable<TFields>(
	{ storage }: { storage: FolderStorage },
	name: string,
	table: PreparedFolderTable,
	unsupplied: readonly string[] = [],
): FileTable<TFields> {
	const kind = { kind: 'row', table } as const;

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
		if (text === undefined) return TableError.InvalidUtf8({ path, sha256 });
		const { data: row, error: issues } = parseRow(table, text);
		if (issues !== null)
			return TableError.InvalidRow({ path, sha256, text, issues });
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
	function textOf(row: Row<TFields>): Result<string, WriteError> {
		const { data: written, error: issues } = writeRow(
			table,
			row as Parameters<typeof writeRow>[1],
		);
		if (issues !== null) return WriteError.InvalidValues({ issues });
		return Ok(written.text);
	}

	/** The one write of the file at `path`, and the row it left there. */
	async function written(
		path: string,
		from: FileContent | null,
		to: FileContent | null,
	): Promise<Result<WrittenRow<TFields>, WriteError>> {
		const { data, error } = await writeFile(storage, kind, path, from, to);
		if (error !== null) return Err(error);
		if (data.file === null) return Ok(null);
		return Ok(readBack(path, data.file));
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

	const fileTable: FileTable<TFields> = {
		name,
		canCreate: unsupplied.length === 0,
		async list() {
			const { data: filenames, error: listError } = await filenamesOf();
			if (listError !== null) return Err(listError);
			// Only the exact lowercase extension is a row; `a.MD` is an ordinary file.
			const rows = filenames.filter((file) => file.endsWith(ROW_EXTENSION));
			const reads = await readMany(
				storage,
				rows.map((file) => `${name}/${file}`),
			);
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
		async write(stem, from, to) {
			const { data: path, error: addressError } = rowAddress(stem);
			if (addressError !== null) return Err(addressError);
			// Both owned before anything is awaited.
			const base = from === null ? Ok(null) : textOf(from);
			if (base.error !== null) return Err(base.error);
			const next = to === null ? Ok(null) : textOf(to);
			if (next.error !== null) return Err(next.error);
			return written(path, base.data, next.data);
		},
		async set(stem, fields) {
			const { data: current, error: readError } = await fileTable.get(stem);
			if (readError !== null)
				return readError.name === 'InvalidRow'
					? WriteError.InvalidValues({ issues: readError.issues })
					: readError.name === 'InvalidUtf8'
						? WriteError.InvalidValues({
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
				return WriteError.InvalidValues({
					issues: unsupplied.map((field) => ({
						message: `The folder requires '${name}.${field}' in every row, which this lens does not declare, so it cannot add rows`,
						field,
					})),
				});
			return fileTable.write(options?.stem ?? generateStem(), null, row);
		},
		async delete(stem) {
			const { data: path, error: addressError } = rowAddress(stem);
			if (addressError !== null) return Err(addressError);
			const { error } = await writeFile(storage, kind, path, null, null);
			return error === null ? Ok(undefined) : Err(error);
		},
		async rename(stem, next) {
			const { data: from, error: fromError } = rowAddress(stem);
			if (fromError !== null) return Err(fromError);
			const { data: to, error: toError } = rowAddress(next);
			if (toError !== null) return Err(toError);
			const read = await storage.read(from);
			if (read.error !== null)
				return read.error.name === 'NotFound'
					? WriteError.InvalidPath({
							path: from,
							reason: 'no row is at this stem',
						})
					: Err(writeFailure(from, read.error));
			if (to === from) return written(from, read.data.bytes, read.data.bytes);
			const movedRow = (moved: { bytes: Uint8Array; sha256: string }) =>
				Ok(readBack(to, moved));
			// The bytes land at `next` only where nothing is, so two renames
			// onto one stem never fuse two rows.
			let moved = read.data;
			const placed = await confirmedPut(
				storage,
				to,
				moved.bytes,
				null,
				moved.sha256,
			);
			if (placed.error !== null) return Err(writeFailure(to, placed.error));
			if (placed.data === 'stale')
				return WriteError.InvalidPath({
					path: to,
					reason: 'a row is already at this stem',
				});
			// The old stem goes only while it holds what moved; a write that
			// landed there since is carried to `next` first.
			for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
				const removed = await confirmedPut(
					storage,
					from,
					null,
					moved.sha256,
					null,
				);
				if (removed.error !== null)
					return Err(writeFailure(from, removed.error));
				if (removed.data === 'landed') return movedRow(moved);
				const now = await storage.read(from);
				if (now.error?.name === 'NotFound') {
					// The row was deleted while it moved: the delete stands, so
					// its copy at `next` goes too, unless something wrote there.
					const undone = await confirmedPut(
						storage,
						to,
						null,
						moved.sha256,
						null,
					);
					if (undone.error !== null) return Err(writeFailure(to, undone.error));
					return WriteError.InvalidPath({
						path: from,
						reason: 'no row is at this stem',
					});
				}
				if (now.error !== null) return Err(writeFailure(from, now.error));
				const carried = await confirmedPut(
					storage,
					to,
					now.data.bytes,
					moved.sha256,
					now.data.sha256,
				);
				if (carried.error !== null) return Err(writeFailure(to, carried.error));
				if (carried.data === 'stale') break;
				moved = now.data;
			}
			return WriteError.KeptChanging({ path: from, attempts: WRITE_ATTEMPTS });
		},
	};
	return fileTable;
}
