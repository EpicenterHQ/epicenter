/**
 * Read a data folder on disk without opening it (ADR-0517).
 *
 * A data folder is a directory with at least one table: a top-level
 * directory holding a `.epicenter.json`, its schema. `readFolder` discovers
 * and prepares those tables, then reads every one through the same tables and
 * directory file storage an opened folder uses, so a tool and an application
 * reach the same verdict on every file: path policy, symbolic links, names,
 * UTF-8, and row validity included.
 *
 * It writes nothing. It takes no lock, leaves no marker, initializes no Git
 * repository, and publishes no definition, so it can read a folder an
 * application has open, or one nested in any repository.
 */

import { lstat, realpath } from 'node:fs/promises';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { readDefinition } from './declaration.js';
import type { Definition, PreparedFolderTable } from './definition.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createDirectoryStorage } from './directory-store.js';
import { FileError } from './errors.js';
import { SCHEMA_FILE } from './paths.js';
import { createTable, type TableListing } from './table.js';

export const ReadFolderError = defineErrors({
	/** No top-level directory holds a `.epicenter.json`, so it is not a data folder. */
	NotDataFolder: ({ root }: { root: string }) => ({
		message: `'${root}' is not a data folder: no top-level directory holds a ${SCHEMA_FILE}`,
		root,
	}),
	/**
	 * A table's schema file (`path`; `''` when the root could not be listed) is not a
	 * readable file, is not UTF-8 JSON, is not the schema grammar
	 * `parseTableSchema` reads, or declares a field a folder cannot keep.
	 */
	InvalidDefinition: ({
		root,
		reason,
		path,
	}: {
		root: string;
		reason: string;
		path: string;
	}) => ({
		message:
			path === ''
				? `'${root}' cannot be read for its tables: ${reason}`
				: `'${root}/${path}' cannot be used: ${reason}`,
		root,
		reason,
		path,
	}),
});
export type ReadFolderError = InferErrors<typeof ReadFolderError>;

/** What a data folder holds, read once. */
export type FolderReading = {
	/** The directory read, as the caller named it. */
	readonly root: string;
	/** The prepared definition its tables' schema files declare. */
	readonly definition: Definition;
	/** Exactly what each declared table's `list()` returns. */
	readonly tables: Readonly<
		Record<string, Result<TableListing<Record<string, unknown>>, FileError>>
	>;
};

/**
 * Read the data folder at `root`. A directory with no table is
 * `NotDataFolder`; one with a schema file that cannot be used is
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
	});

	const { data: definition, error: declarationError } =
		await readDefinition(storage);
	if (declarationError !== null)
		return ReadFolderError.InvalidDefinition({
			root,
			reason: declarationError.reason,
			path: declarationError.path,
		});
	if (Object.keys(definition.tables).length === 0)
		return ReadFolderError.NotDataFolder({ root });

	const tables: Record<
		string,
		Result<TableListing<Record<string, unknown>>, FileError>
	> = {};
	for (const [name, table] of Object.entries(definition.tables))
		tables[name] = await createTable<Record<string, unknown>>(
			{ storage },
			name,
			table as PreparedFolderTable,
		).list();
	return Ok(
		Object.freeze({
			root,
			definition,
			tables: Object.freeze(tables),
		}),
	);
}
