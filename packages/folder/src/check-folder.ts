/**
 * Check a data folder on disk: read it through `readFolder`, the same reading
 * apps use, and sort what it reports into the files to fix and the files that
 * could not be read (ADR-0520). `epicenter check` prints this; `epicenter
 * query` projects the rows that conform and names the rest.
 *
 * Nothing executable is read and nothing is written.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileError } from './errors.js';
import type { ProjectedTable } from './projection.js';
import { type ReadFolderError, readFolder } from './read-folder.js';

/**
 * The authored TypeScript declaration `generateDeclaration` reads
 * (ADR-0527). `checkFolder` only asks whether it exists; it never runs it.
 */
export const DECLARATION_SOURCE_PATH = 'epicenter.ts';

/** One finding, located as precisely as the source allows. */
export type Finding = {
	path: string;
	line?: number;
	field?: string;
	message: string;
};

/** One declared table, with its fields and the rows that conform, sorted by stem. */
export type CheckedTable = ProjectedTable & {
	fields: { name: string; schema: object }[];
	rows: {
		stem: string;
		fields: Record<string, unknown>;
		body: string;
	}[];
};

/** What `checkFolder` found. */
export type FolderCheck = {
	tables: CheckedTable[];
	/** The rows that conform, across every table. */
	rows: number;
	/**
	 * Files to fix: a row that does not conform, bytes that are not UTF-8,
	 * or a path the folder cannot hold, such as a symbolic link.
	 */
	invalid: Finding[];
	/** Files that could not be read at all. */
	unreadable: Finding[];
	/** Whether `epicenter.ts` sits beside `epicenter.json`. */
	hasSource: boolean;
};

/** The fields of the folder package's read errors that a finding draws on. */
type ReadError = {
	name: string;
	message: string;
	reason?: string;
	issues?: readonly Omit<Finding, 'path'>[];
};

/** Whether `path` is a file; only that is ever asked of `epicenter.ts` here. */
function isFile(path: string) {
	return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** Whether `dir` holds an `epicenter.ts` to generate its declaration from. */
export function hasDeclarationSource(dir: string) {
	return isFile(resolve(dir, DECLARATION_SOURCE_PATH));
}

/**
 * Read the data folder at `dir` and sort what it reports. A folder or
 * declaration that cannot be used is the error; a file that does not conform
 * or cannot be read is a finding beside the others.
 */
export async function checkFolder(
	dir: string,
): Promise<Result<FolderCheck, ReadFolderError | FileError>> {
	const { data: folder, error } = await readFolder(dir);
	if (error !== null) return Err(error);
	const invalid: Finding[] = [];
	const unreadable: Finding[] = [];
	function report(path: string, failure: ReadError) {
		if (failure.issues)
			for (const issue of failure.issues) invalid.push({ path, ...issue });
		else if (failure.name === 'InvalidUtf8')
			invalid.push({ path, message: 'The file is not valid UTF-8 text' });
		else if (failure.name === 'InvalidPath')
			invalid.push({
				path,
				message: `The path is not usable: ${failure.reason}`,
			});
		else if (failure.name === 'NotAFile')
			invalid.push({ path, message: 'A row must be a file, not a directory' });
		else unreadable.push({ path, message: failure.message });
	}

	const tables: CheckedTable[] = [];
	for (const [name, listed] of Object.entries(folder.tables)) {
		const table: CheckedTable = {
			name,
			fields: Object.entries(folder.definition.tables[name]?.fields ?? {}).map(
				([field, schema]) => ({ name: field, schema }),
			),
			rows: [],
		};
		tables.push(table);
		if (listed.error !== null) {
			report(name, listed.error);
			continue;
		}
		// A listing has no promised order; sorting keeps output stable.
		for (const { stem, result } of [...listed.data].sort((a, b) =>
			a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0,
		)) {
			if (result.error !== null) report(`${name}/${stem}.md`, result.error);
			else
				table.rows.push({
					stem,
					fields: result.data.row.fields,
					body: result.data.row.body,
				});
		}
	}
	return Ok({
		tables,
		rows: tables.reduce((sum, table) => sum + table.rows.length, 0),
		invalid,
		unreadable,
		hasSource: hasDeclarationSource(dir),
	});
}

/** Each file `check` reported, once, in the order reported: what `query` leaves out. */
export function excludedFiles({ invalid, unreadable }: FolderCheck) {
	return [...new Set([...unreadable, ...invalid].map(({ path }) => path))];
}
