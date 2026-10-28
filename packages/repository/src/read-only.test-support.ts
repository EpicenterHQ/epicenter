/**
 * The statements a repository's SQL read must refuse, shared by the Bun test
 * (`read-only.test.ts`) and the browser host test, so both hosts are held to
 * one list. Each is more than one statement, or would change the database,
 * the connection, or what later statements see.
 */
export const REFUSED_READS = {
	'an UPDATE that returns rows': `UPDATE "epicenter/files" SET text = 'changed' RETURNING path`,
	'a read followed by a second statement': `SELECT 1; DELETE FROM "epicenter/notices"`,
	'two reads': 'SELECT 1; SELECT 2',
	'a read followed by text that is not a statement': 'SELECT 1; not sql',
	'an ATTACH': `ATTACH ':memory:' AS other`,
	'a BEGIN': 'BEGIN',
	'a SAVEPOINT': 'SAVEPOINT s',
	'a PRAGMA that writes the database': 'PRAGMA user_version = 7',
	'a PRAGMA that changes the connection': 'PRAGMA query_only = OFF',
	'a temporary table': 'CREATE TEMP TABLE scratch (a)',
} as const;

/** Reads that must still run: one statement over a view, an engine table, a comment and a trailing semicolon. */
export const ALLOWED_READS = {
	'a view': 'SELECT stem FROM notes ORDER BY stem',
	'an engine table, with a comment and a trailing semicolon': `-- how many\nSELECT count(*) AS n FROM "epicenter/files"; /* done */`,
	'a common table expression': 'WITH x AS (SELECT 1 AS n) SELECT n FROM x',
} as const;
