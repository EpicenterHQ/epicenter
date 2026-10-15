/**
 * Answer one read-only SQL statement over a checked data folder, in Bun
 * (ADR-0520, ADR-0494): the rows that conform are projected into an in-memory
 * `bun:sqlite` database, the statement runs, and the database is dropped.
 * Files that do not conform are left out whole and named.
 */

import { Database } from 'bun:sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { excludedFiles, type FolderCheck } from './check-folder.js';
import {
	projectionProblem,
	projectTables,
	readingStatementProblem,
	type SqlTarget,
} from './projection.js';

export const QueryFolderError = defineErrors({
	/** The declaration cannot be projected, or the statement may not run. */
	Refused: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type QueryFolderError = InferErrors<typeof QueryFolderError>;

/** What a statement answered, and the files left out of every table. */
export type QueryAnswer = {
	columns: string[];
	rows: Record<string, unknown>[];
	excluded: string[];
};

/** The two calls the projection asks of a database, over `bun:sqlite`. */
function sqlTarget(db: Database): SqlTarget {
	return {
		run: (sql, parameters = []) => db.run(sql, [...parameters]),
		transaction: (run) => db.transaction(run).immediate(),
	};
}

const TRAILING_TRIVIA = /--[^\n]*|\/\*[\s\S]*?\*\/|[\s;]/g;

/**
 * Run `sql` over the rows of `checked` that conform. The statement must be
 * exactly one that only reads: the projection refuses one that does not
 * start with a reading keyword, and SQLite prepares only the first of
 * several statements, so anything after it is refused rather than silently
 * ignored.
 */
export function queryFolder(
	checked: FolderCheck,
	sql: string,
): Result<QueryAnswer, QueryFolderError> {
	for (const table of checked.tables) {
		const problem = projectionProblem(table);
		if (problem !== undefined)
			return QueryFolderError.Refused({ reason: problem });
	}
	const problem = readingStatementProblem(sql);
	if (problem !== undefined)
		return QueryFolderError.Refused({ reason: problem });
	const db = new Database(':memory:');
	try {
		projectTables(sqlTarget(db), checked.tables);
		let statement: ReturnType<Database['query']>;
		try {
			statement = db.query(sql);
		} catch (cause) {
			return QueryFolderError.Refused({
				reason: cause instanceof Error ? cause.message : String(cause),
			});
		}
		if (sql.slice(statement.toString().length).replace(TRAILING_TRIVIA, ''))
			return QueryFolderError.Refused({
				reason: 'query runs one statement; remove everything after the first',
			});
		let rows: Record<string, unknown>[];
		try {
			rows = statement.all() as Record<string, unknown>[];
		} catch (cause) {
			return QueryFolderError.Refused({
				reason: cause instanceof Error ? cause.message : String(cause),
			});
		}
		return Ok({
			columns: statement.columnNames,
			rows,
			excluded: excludedFiles(checked),
		});
	} finally {
		db.close();
	}
}
