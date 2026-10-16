/**
 * File-backed tables: Markdown rows at `<table>/<stem>.md` (ADR-0457, ADR-0518).
 *
 * Every read goes through `parseRow` and every write through `formatRow`
 * (`row-text.ts`), so what a table writes it always reads back as the same
 * row. A read that found text is a `StoredRow`: the path and SHA-256 of the
 * bytes read, their exact text, and the row they hold. Text that is not a
 * valid row is `InvalidRow`, which keeps the exact text and its hash for raw
 * repair.
 *
 * Every write after `create` names the bytes it started from: a capture,
 * `{ path, sha256 }`. A `StoredRow`, an `InvalidRow`, or a listed row passes
 * as it is. `rename` and `delete` are refused as `Conflict` when the file no
 * longer holds those bytes, and nothing retries (ADR-0464). `save` merges
 * instead (ADR-0551): it is `saveFile` over the row's kind, so a file
 * another writer changed is read again, merged by field and the body by
 * line, and written over its current bytes, as every save in the folder is.
 * `create` alone is unconditional, and refuses an occupied stem. The hash is
 * a condition on bytes, not an identity or a revision.
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
	type ContentCapture,
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
	type TableSetBodyError,
	type TableUpdateError,
} from './errors.js';
import { mergeLines } from './git/merge-lines.js';
import { frameRowText } from './markdown.js';
import {
	ROW_EXTENSION,
	rowAddressProblem,
	rowPath,
	rowStemOf,
} from './paths.js';
import { parseRow, type Row, wellFormed, writeRow } from './row-text.js';
import {
	logOverwrite,
	type SaveOptions,
	saveFile,
	WRITE_ATTEMPTS,
} from './save-file.js';
import { applyOne, replaceCaptured } from './storage.js';

/**
 * One read or write of a row file: which bytes, their exact text, and the
 * row they hold. The capture never changes; it is the base a save merges
 * from, so an edit belongs in a copy of `row`, never in `row` itself.
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

/** The keys of `T` that may be absent; any key of a row whose fields are not declared. */
type OptionalKeys<T> = string extends keyof T
	? string
	: {
			[K in keyof T]-?: object extends Pick<T, K> ? K : never;
		}[keyof T];

/**
 * What an update changes: `set` puts values in fields, and `unset` removes
 * optional fields. Plain data, so it can be shown, logged, and sent again.
 */
export type RowUpdate<TFields> = {
	readonly set?: Partial<TFields>;
	readonly unset?: readonly OptionalKeys<TFields>[];
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
};

/** How `setBody` treats a body another writer changed since `base`. */
export type SetBodyOptions = {
	/**
	 * `true` writes only while the body is still `base.row.body`, and answers
	 * `Conflict` when it changed; a change to the fields does not block it.
	 * Defaults to merging.
	 */
	readonly ifUnchanged?: boolean;
};

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
	 * Save an edit of the row file `file` captured (ADR-0551). When the file
	 * still holds the captured bytes, `row` is written over them. Otherwise
	 * another writer changed it: the current file is read and merged with the
	 * edit, field by field and the body by line, from the captured row as the
	 * base, with the edit winning only where both changed the same field or
	 * the same lines, and the merge is written over the current bytes. That
	 * repeats at most `WRITE_ATTEMPTS` times. With `{ merge: false }` a moved
	 * file is `Conflict` instead.
	 *
	 * `file` must carry the content it names: a `StoredRow` or an
	 * `InvalidRow`. One without content, or whose content no longer hashes to
	 * its SHA-256, is `UnknownBase`.
	 *
	 * Fails, writing nothing, when `row` does not conform or cannot be
	 * written (`InvalidValues`), the file was deleted (`NotFound`; a save
	 * never recreates a row), another writer left text that is not a row and
	 * does not merge into one (`InvalidRow`), or the file kept changing
	 * (`KeptChanging`).
	 */
	save(
		file: ContentCapture,
		row: Row<TFields>,
		options?: SaveOptions,
	): Promise<Result<SavedRow<TFields>, TableSaveError>>;
	/**
	 * Set and unset fields of the row at `stem` as it is now (ADR-0554).
	 * Each attempt reads the row, puts `set` over its fields, removes each
	 * field in `unset`, and saves that over what it read with the body
	 * unchanged and no merge. When another writer saved between the read and
	 * the write, the attempt is `Conflict` and the next one starts from their
	 * row, so their fields stay and the update wins only the fields it
	 * names. After `WRITE_ATTEMPTS` conflicts it is `KeptChanging`. An
	 * update replaces nothing it did not name.
	 *
	 * `unset` names optional fields only; `null` may be a field's real value.
	 * `NotFound` when no file is at the stem (an update never creates a row),
	 * `InvalidRow` or `InvalidUtf8` when the file is not a row, and otherwise
	 * what `save` refuses: a value that does not conform is `InvalidValues`.
	 */
	update(
		stem: string,
		change: RowUpdate<TFields>,
	): Promise<Result<SavedRow<TFields>, TableUpdateError>>;
	/**
	 * Replace the body of the row file `base` was read from with `text`, on
	 * the file as it is now (ADR-0575). Each attempt reads the file and keeps
	 * every byte before its body exactly: frontmatter, keys the table does not
	 * declare, comments, and line endings. When the body changed since `base`,
	 * `text` is merged with it by line from `base.row.body`, `text` winning
	 * lines both changed; each overwrite is logged, not returned. With
	 * `{ ifUnchanged: true }` a changed body is `Conflict` instead, whatever
	 * happened to the fields. The new body has `\n` line endings and
	 * well-formed text, and is written guarded by what the attempt read;
	 * another writer in between starts the next attempt. After
	 * `WRITE_ATTEMPTS` it is `KeptChanging`.
	 *
	 * Writes nothing when the body would not change. `NotFound` when the file
	 * is gone (a body is never written to a new file), and `InvalidRow` or
	 * `InvalidUtf8` when it does not read as a row of this table, including
	 * text with no closed frontmatter.
	 */
	setBody(
		base: StoredRow<TFields>,
		text: string,
		options?: SetBodyOptions,
	): Promise<Result<SavedRow<TFields>, TableSetBodyError>>;
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
		return Ok(Object.freeze({ path, sha256, text, row: row as Row<TFields> }));
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
			return Ok(
				Object.freeze({ path, sha256, text: prepared.text, row: prepared.row }),
			);
		},
		async save(file, row, options) {
			const { data: captured, error: captureError } = ownRowCapture(file);
			if (captureError !== null) return Err(captureError);
			const { data: edit, error: prepareError } = prepare(row);
			if (prepareError !== null) return Err(prepareError);
			const { data: written, error } = await saveFile(
				storage,
				{ kind: 'row', table },
				{ ...file, ...captured },
				edit.bytes,
				options,
			);
			if (error !== null) return Err(error as TableSaveError);
			// The written bytes read as a row: the edit's, or a merge `saveFile`
			// checked reads as one.
			const stored = storedRow(written.path, written);
			if (stored.error !== null)
				throw new Error('A saved row does not read as a row');
			return Ok(
				Object.freeze({
					stored: stored.data,
					merged: written.merged,
				}),
			);
		},
		async update(stem, { set = {}, unset = [] }) {
			for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
				const { data: current, error: readError } = await fileTable.get(stem);
				if (readError !== null) return Err(readError);
				if (current === undefined)
					return FileError.NotFound({ path: rowPath(name, stem) });
				const fields: Record<string, unknown> = {
					...current.row.fields,
					...set,
				};
				for (const field of unset) delete fields[field as string];
				const saved = await fileTable.save(
					current,
					{
						fields: fields as Row<TFields>['fields'],
						body: current.row.body,
					},
					{ merge: false },
				);
				if (saved.error?.name !== 'Conflict') return saved;
			}
			return TableError.KeptChanging({
				path: rowPath(name, stem),
				attempts: WRITE_ATTEMPTS,
			});
		},
		async setBody(base, text, { ifUnchanged = false } = {}) {
			const { data: captured, error: captureError } = ownRowCapture(base);
			if (captureError !== null) return Err(captureError);
			const { path } = captured;
			// Owned before anything is awaited, so later edits change nothing.
			const baseBody = base.row.body;
			const typed = wellFormed(text.replace(/\r\n?/g, '\n'));
			for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
				const { data: read, error: readError } = await storage.read(path);
				if (readError !== null) return Err(readError);
				const { data: current, error: rowError } = storedRow(path, read);
				if (rowError !== null) return Err(rowError);
				const frame = frameRowText(current.text);
				// A row always has closed frontmatter; this keeps the splice honest.
				if (frame.kind !== 'frontmatter')
					return TableError.InvalidRow({
						path,
						sha256: current.sha256,
						text: current.text,
						issues: [{ message: 'The file has no closed frontmatter' }],
					});
				const merged = current.row.body !== baseBody;
				if (merged && ifUnchanged)
					return FileError.Conflict({
						path,
						expectedSha256: base.sha256,
						actualSha256: current.sha256,
					});
				let body = typed;
				let overwrote: Parameters<typeof logOverwrite>[1] = [];
				if (merged) {
					const merge = await mergeLines({
						base: baseBody,
						ours: typed,
						theirs: current.row.body,
					});
					body = merge.ours;
					overwrote = merge.regions.map((region) => ({
						kind: 'lines',
						part: 'body',
						line: region.line + 1,
					}));
				}
				if (body === current.row.body)
					return Ok(Object.freeze({ stored: current, merged }));
				const head = current.text.slice(0, frame.bodyStart);
				const nextText = `${head}${head.endsWith('\n') ? '' : frame.newline}${body}`;
				const { bytes, text: written } = submittedText(nextText);
				const { data: row, error: issues } = parseRow(table, written);
				if (issues !== null) return TableError.InvalidValues({ issues });
				const { data: saved, error: saveError } = await replaceCaptured(
					storage,
					fileCapture(path, current.sha256),
					bytes,
				);
				if (saveError === null) {
					logOverwrite(path, overwrote);
					return Ok(
						Object.freeze({
							stored: Object.freeze({
								path,
								sha256: saved.sha256,
								text: written,
								row: row as Row<TFields>,
							}),
							merged,
						}),
					);
				}
				if (saveError.name !== 'Conflict') return Err(saveError);
			}
			return TableError.KeptChanging({ path, attempts: WRITE_ATTEMPTS });
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
	return fileTable;
}
