/**
 * Read a data folder on disk without opening it (ADR-0517), for the CLI's
 * `check` and `query` (ADR-0632).
 *
 * A data folder is a directory holding `epicenter.json`. `readFolder` reads
 * and prepares that definition, then reads every defined table's rows
 * through the directory file storage, so path policy, symbolic links, names,
 * UTF-8, and row validity are the storage's verdict on every file.
 *
 * It writes nothing. It takes no lock, leaves no marker, initializes no Git
 * repository, and publishes no definition, so it can read a folder an
 * application has open, or one nested in any repository.
 */

import { lstat, realpath } from 'node:fs/promises';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { readDefinition } from './declaration.js';
import type { Declaration, PortableTableSchema } from './declaration-schema.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createDirectoryStorage } from './directory-store.js';
import { FileError, RowReadError } from './errors.js';
import { scratchDirectory } from './native/directory.js';
import { DEFINITION_PATH, ROW_EXTENSION } from './paths.js';
import { parseDeclaredRow, type Row } from './row-text.js';

/**
 * One row file as read: which bytes, their exact text, and the row they hold.
 */
export type StoredRow<TFields> = {
	readonly path: string;
	readonly sha256: string;
	readonly text: string;
	readonly row: Row<TFields>;
};

/**
 * One item for every `.md` name directly in the table's directory, in name
 * order. A symbolic link is that item's `InvalidPath` and a directory its
 * `NotAFile`. A file that went away after it was enumerated is that item's
 * `NotFound`.
 */
export type TableListing<TFields> = readonly {
	readonly stem: string;
	readonly result: Result<StoredRow<TFields>, RowReadError>;
}[];

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Every row file of table `name`, read through `table`; none when its directory is missing. */
async function listTable(
	storage: FolderStorage,
	name: string,
	table: PortableTableSchema,
): Promise<Result<TableListing<Record<string, unknown>>, FileError>> {
	const { data: children, error } = await storage.children(name);
	if (error !== null) return error.name === 'NotFound' ? Ok([]) : Err(error);
	// A directory named like a row is included so reading reports it. Only the
	// exact lowercase extension is a row; `a.MD` is an ordinary file.
	const filenames = [...children.files, ...children.directories].sort();
	const rows: TableListing<Record<string, unknown>>[number][] = [];
	for (const file of filenames) {
		if (!file.endsWith(ROW_EXTENSION)) continue;
		const path = `${name}/${file}`;
		const read = await storage.read(path);
		rows.push(
			Object.freeze({
				stem: file.slice(0, -ROW_EXTENSION.length),
				result:
					read.error !== null ? Err(read.error) : storedRow(path, read.data),
			}),
		);
	}
	return Ok(Object.freeze(rows));

	function storedRow(
		path: string,
		{ bytes, sha256 }: { bytes: Uint8Array; sha256: string },
	): Result<StoredRow<Record<string, unknown>>, RowReadError> {
		let text: string;
		try {
			text = utf8.decode(bytes);
		} catch {
			return RowReadError.InvalidUtf8({ path, sha256 });
		}
		const { data: row, error: issues } = parseDeclaredRow(table, text);
		if (issues !== null)
			return RowReadError.InvalidRow({ path, sha256, text, issues });
		return Ok(
			Object.freeze({
				path,
				sha256,
				text,
				row: row as Row<Record<string, unknown>>,
			}),
		);
	}
}

export const ReadFolderError = defineErrors({
	/** The directory has no `epicenter.json`, so it is not a data folder. */
	NotDataFolder: ({ root }: { root: string }) => ({
		message: `'${root}' is not a data folder: it has no ${DEFINITION_PATH}`,
		root,
	}),
	/**
	 * `epicenter.json` (`path`) is not a readable file, is not UTF-8 JSON, is
	 * not the portable table grammar `readDeclaredTables` reads, or declares a field
	 * a folder cannot keep.
	 */
	InvalidDefinition: ({ root, reason }: { root: string; reason: string }) => ({
		message: `'${root}/${DEFINITION_PATH}' cannot be used: ${reason}`,
		root,
		reason,
		path: DEFINITION_PATH,
	}),
});
export type ReadFolderError = InferErrors<typeof ReadFolderError>;

/** What a data folder holds, read once. */
export type FolderReading = {
	/** The directory read, as the caller named it. */
	readonly root: string;
	/** The prepared definition from `epicenter.json`. */
	readonly definition: { tables: NonNullable<Declaration['tables']> };
	/** Each declared table's rows, or why its directory could not be listed. */
	readonly tables: Readonly<
		Record<string, Result<TableListing<Record<string, unknown>>, FileError>>
	>;
};

/**
 * Read the data folder at `root`. A directory with no `epicenter.json` is
 * `NotDataFolder`; one whose definition cannot be used is
 * `InvalidDefinition`; a missing root is `NotFound`, and a root that is not
 * a directory is `NotADirectory`. A table that cannot be read is that
 * entry's error, beside the others.
 */
export async function readFolder(
	root: string,
): Promise<Result<FolderReading, ReadFolderError | FileError>> {
	let resolved: string;
	try {
		resolved = await realpath(root);
		if (!(await lstat(resolved)).isDirectory())
			return FileError.NotADirectory({ path: root });
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === 'ENOENT'
			? FileError.NotFound({ path: root })
			: FileError.Io({ path: root, operation: 'open', cause });
	}
	const storage = createDirectoryStorage({
		root: resolved,
		primitives: nodeDirectoryPrimitives,
		scratch: scratchDirectory(resolved),
	});

	const { data: definition, error: declarationError } =
		await readDefinition(storage);
	if (declarationError !== null)
		return ReadFolderError.InvalidDefinition({
			root,
			reason: declarationError.reason,
		});
	if (definition === undefined) return ReadFolderError.NotDataFolder({ root });

	const tables: Record<
		string,
		Result<TableListing<Record<string, unknown>>, FileError>
	> = {};
	for (const [name, table] of Object.entries(definition.tables))
		tables[name] = await listTable(storage, name, table);
	return Ok(
		Object.freeze({
			root,
			definition,
			tables: Object.freeze(tables),
		}),
	);
}
