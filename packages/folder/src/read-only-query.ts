/**
 * Answer one read-only SQL statement over a disposable in-memory `bun:sqlite`
 * projection that the caller populates (ADR-0494). The desktop editor's
 * `documents-query` reads saved Markdown documents through it.
 */

import { Database } from 'bun:sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export const QueryError = defineErrors({
	/** The statement may not run. */
	Refused: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type QueryError = InferErrors<typeof QueryError>;

/** What a statement answered, and the files left out of every table. */
export type QueryAnswer = {
	columns: string[];
	rows: Record<string, unknown>[];
	excluded: string[];
	truncated?: boolean;
};

const TRAILING_TRIVIA = /--[^\n]*|\/\*[\s\S]*?\*\/|[\s;]/g;

const LEADING_TRIVIA = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
/** The keywords a statement over a projection may start with. */
const READING_KEYWORDS = ['SELECT', 'WITH', 'VALUES', 'EXPLAIN'];

/**
 * Why `sql` may not run over a projection, or `undefined` when its first
 * keyword reads. `query_only` stops changes to the projection, but not
 * `ATTACH` or `VACUUM INTO`, which create files, so a statement must start
 * with a reading keyword. The engine that prepares it still refuses anything
 * after the first statement.
 */
export function readingStatementProblem(sql: string): string | undefined {
	const keyword = sql
		.replace(LEADING_TRIVIA, '')
		.match(/^[A-Za-z]+/)?.[0]
		?.toUpperCase();
	if (!keyword) return 'query takes one SQL statement; this one is empty';
	if (!READING_KEYWORDS.includes(keyword))
		return `query only reads: a statement must start with SELECT, WITH, VALUES, or EXPLAIN, not ${keyword}`;
	return undefined;
}

/** One executor owns SQLite read-only policy for every disposable projection. */
export function queryProjection(
	sql: string,
	populate: (db: Database) => void,
	excluded: string[] = [],
	limits: { rows: number; bytes: number } | undefined = undefined,
): Result<QueryAnswer, QueryError> {
	const problem = readingStatementProblem(sql);
	if (problem !== undefined) return QueryError.Refused({ reason: problem });
	const db = new Database(':memory:');
	try {
		populate(db);
		let statement: ReturnType<Database['query']>;
		try {
			statement = db.query(sql);
		} catch (cause) {
			return QueryError.Refused({
				reason: cause instanceof Error ? cause.message : String(cause),
			});
		}
		if (sql.slice(statement.toString().length).replace(TRAILING_TRIVIA, ''))
			return QueryError.Refused({
				reason: 'query runs one statement; remove everything after the first',
			});
		const rows: Record<string, unknown>[] = [];
		let truncated = false;
		try {
			let bytes = 0;
			for (const row of statement.iterate() as Iterable<
				Record<string, unknown>
			>) {
				const normalized =
					limits === undefined
						? row
						: Object.fromEntries(
								Object.entries(row).map(([key, value]) => [
									key,
									value instanceof Uint8Array ? Array.from(value) : value,
								]),
							);
				if (limits !== undefined) {
					bytes += new TextEncoder().encode(
						JSON.stringify(normalized),
					).byteLength;
					if (rows.length >= limits.rows || bytes > limits.bytes) {
						truncated = true;
						break;
					}
				}
				rows.push(normalized);
			}
		} catch (cause) {
			return QueryError.Refused({
				reason: cause instanceof Error ? cause.message : String(cause),
			});
		}
		return Ok({
			columns: statement.columnNames,
			rows,
			...(limits === undefined ? {} : { truncated }),
			excluded,
		});
	} finally {
		db.close();
	}
}
