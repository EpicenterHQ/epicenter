/**
 * Read a data folder on disk without opening it (ADR-0517).
 *
 * A data folder is a directory holding `epicenter.json`. `readFolder` reads
 * and prepares that definition, then reads every defined table through the
 * same tables and directory file storage an opened folder uses, so a tool and an application reach the same verdict
 * on every file: path policy, symbolic links, names, UTF-8, and row
 * validity included.
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
import { DEFINITION_PATH } from './paths.js';
import { createTable, type TableListing } from './table.js';

export const ReadFolderError = defineErrors({
	/** The directory has no `epicenter.json`, so it is not a data folder. */
	NotDataFolder: ({ root }: { root: string }) => ({
		message: `'${root}' is not a data folder: it has no ${DEFINITION_PATH}`,
		root,
	}),
	/**
	 * `epicenter.json` (`path`) is not a readable file, is not UTF-8 JSON, is
	 * not the definition grammar `parseDefinition` reads, or declares a field
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
	readonly definition: Definition;
	/** Exactly what each declared table's `list()` returns. */
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
