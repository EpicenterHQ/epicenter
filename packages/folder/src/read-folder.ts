/**
 * Read a data folder on disk without opening it (ADR-0517).
 *
 * A data folder is a directory holding `epicenter.json`. `readFolder` reads
 * and prepares that declaration, then reads every declared table and
 * `kv.json` through the same tables, settings, and directory file storage an
 * opened folder uses, so a tool and an application reach the same verdict
 * on every file: path policy, symbolic links, names, UTF-8, and row
 * validity included.
 *
 * It writes nothing. It takes no lock, leaves no marker, initializes no Git
 * repository, and publishes no declaration, so it can read a folder an
 * application has open, or one nested in any repository.
 */

import { lstat, realpath } from 'node:fs/promises';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { readDeclaration } from './declaration.js';
import type { FolderDefinition, PreparedFolderTable } from './definition.js';
import {
	FileError,
	type KvReadError,
	type TableEnumerationError,
} from './errors.js';
import { createKv, type KvReading } from './kv.js';
import { directoryHandle } from './directory-handle.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createOpfsFileBoundary } from './opfs-store.js';
import { createProcessLocks } from './process-locks.js';
import { DECLARATION_PATH } from './paths.js';
import { createTable, type TableListing } from './table.js';

export const ReadFolderError = defineErrors({
	/** The directory has no `epicenter.json`, so it is not a data folder. */
	NotDataFolder: ({ root }: { root: string }) => ({
		message: `'${root}' is not a data folder: it has no ${DECLARATION_PATH}`,
		root,
	}),
	/**
	 * `epicenter.json` is not a readable file, is not UTF-8 JSON, is not the
	 * declaration grammar `parseDeclaration` reads, or declares a field a
	 * folder cannot keep.
	 */
	InvalidDeclaration: ({ root, reason }: { root: string; reason: string }) => ({
		message: `'${root}/${DECLARATION_PATH}' cannot be used: ${reason}`,
		root,
		reason,
	}),
});
export type ReadFolderError = InferErrors<typeof ReadFolderError>;

/** What a data folder holds, read once. */
export type FolderReading = {
	/** The directory read, as the caller named it. */
	readonly root: string;
	/** The prepared declaration from `epicenter.json`. */
	readonly definition: FolderDefinition;
	/** Exactly what each declared table's `list()` returns. */
	readonly tables: Readonly<
		Record<
			string,
			Result<TableListing<Record<string, unknown>>, TableEnumerationError>
		>
	>;
	/** Exactly what `kv.get()` returns. */
	readonly kv: Result<
		KvReading<Record<string, unknown>> | undefined,
		KvReadError
	>;
};

/**
 * Read the data folder at `root`. A directory with no `epicenter.json` is
 * `NotDataFolder`; one whose declaration cannot be used is
 * `InvalidDeclaration`; a missing root is `NotFound`, and a root that is not a directory is
 * `NotADirectory`. A
 * table or `kv.json` that cannot be read is that entry's error, beside the
 * others.
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
	// Reads take no lock; the boundary's lock guards only writes, which a
	// reading never makes.
	const storage = createOpfsFileBoundary({
		root: directoryHandle(nodeDirectoryPrimitives, resolved),
		locks: createProcessLocks(),
		filesLock: `epicenter-folder-read:${resolved}`,
		landed: () => {},
	});

	const { data: definition, error: declarationError } =
		await readDeclaration(storage);
	if (declarationError !== null)
		return ReadFolderError.InvalidDeclaration({
			root,
			reason: declarationError.reason,
		});
	if (definition === undefined) return ReadFolderError.NotDataFolder({ root });

	const tables: Record<
		string,
		Result<TableListing<Record<string, unknown>>, TableEnumerationError>
	> = {};
	// prepareFolderDefinition refused body conversions, which JSON cannot carry.
	for (const [name, table] of Object.entries(definition.tables))
		tables[name] = await createTable<Record<string, unknown>>(
			{ storage },
			name,
			table as PreparedFolderTable,
		).list();
	const kv = await createKv<Record<string, unknown>>(
		{ storage },
		definition.kv,
	).get();

	return Ok(
		Object.freeze({
			root,
			definition,
			tables: Object.freeze(tables),
			kv,
		}),
	);
}
