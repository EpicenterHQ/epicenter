/**
 * Read collections with SQL: each collection is a table named by its key, each
 * matching file is a row, and path is the primary key. Columns are path,
 * placeholders, fields, body, problems, and other. A missing one-file
 * collection has zero rows. Each call reads the run's files anew into an
 * in-memory database it discards afterward.
 *
 * The engine refuses writes through read-only deserialization and query_only.
 * Statements returning no columns are refused before running, including ATTACH,
 * VACUUM INTO, CREATE, and BEGIN. A text check admits one SELECT, WITH, or VALUES
 * statement because bun:sqlite exposes no authorizer, PRAGMA can act during
 * preparation, and Bun silently drops a second statement. The environment is
 * trusted and local; this is not a sandbox.
 */
import { Database, SQLiteError, type SQLQueryBindings } from 'bun:sqlite';
import type { TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { type AnyCollection, recordsOf } from './collection.js';
import { folder, isLocalPath } from './context.js';
import { template } from './path.js';

/** Failures from refused SQL or from preparing and running a query. */
export const QueryError = defineErrors({
	/** The statement or its result falls outside collection reads. */
	Refused: ({ message }: { message: string }) => ({ message }),
	/** SQLite rejected the query, or its parameter values were incomplete. */
	Failed: ({ message }: { message: string }) => ({ message }),
});
export type QueryError = InferErrors<typeof QueryError>;
/** One bound SQL value; booleans become 0/1. */
export type QueryValue = string | number | boolean | null;
/**
 * Values for every parameter: an array by position, or an object with bare keys
 * for $name, :name, or @name. Extra named keys are accepted when the query has
 * parameters, as Bun allows.
 */
export type QueryParams =
	| readonly QueryValue[]
	| Readonly<Record<string, QueryValue>>;
/** One result row, keyed by distinct column names. */
export type QueryRow = Record<string, string | number | null>;
/** A collection table and its columns, without reading its files. */
export type QueryTable = {
	table: string;
	path: string;
	columns: {
		name: string;
		type: 'text' | 'integer' | 'real' | 'boolean' | 'json' | 'any';
	}[];
};

const DECLARED_TYPES = {
	text: 'TEXT',
	integer: 'INTEGER',
	real: 'REAL',
	boolean: 'INTEGER',
	json: 'TEXT',
	any: '',
};

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const asciiLower = (name: string) =>
	name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

function kind(definition: TSchema): QueryTable['columns'][number]['type'] {
	const schema = definition as { type?: string; anyOf?: { const?: unknown }[] };
	if (schema.type === 'string') return 'text';
	if (
		Array.isArray(schema.anyOf) &&
		schema.anyOf.every((choice) => typeof choice.const === 'string')
	)
		return 'text';
	if (schema.type === 'integer' || schema.type === 'boolean')
		return schema.type;
	if (schema.type === 'number') return 'real';
	if (schema.type === 'array' || schema.type === 'object') return 'json';
	return 'any';
}

/**
 * Describe tables without reading files. Each non-local collection is named by
 * its key, with path, placeholders, declared fields, body, problems, and other.
 * Path is the primary key; there is no hidden rowid. `.local` collections are omitted.
 */
export function queryTables(
	collections: Record<string, AnyCollection>,
): QueryTable[] {
	return Object.entries(collections)
		.filter(([, collection]) => !isLocalPath(collection.path))
		.map(([table, collection]) => {
			const columns: QueryTable['columns'] = [
				{ name: 'path', type: 'text' },
				...template(collection.path).placeholders.map((name) => ({
					name,
					type: 'text' as const,
				})),
				...Object.entries(collection.fields).map(([name, schema]) => ({
					name,
					type: kind(schema),
				})),
				{ name: 'body', type: 'text' },
				{ name: 'problems', type: 'json' },
				{ name: 'other', type: 'json' },
			];
			const names = new Map<string, string>();
			for (const { name } of columns) {
				const prior = names.get(asciiLower(name));
				if (prior !== undefined)
					throw new Error(
						`collections.${table} has columns "${prior}" and "${name}" that SQLite treats as the same name; rename one`,
					);
				names.set(asciiLower(name), name);
			}
			return { table, path: collection.path, columns };
		});
}

function refuse(message: string): never {
	throw QueryError.Refused({ message }).error;
}

/**
 * PRAGMA can act during preparation, and Bun ignores a second statement.
 * Admit one SELECT, WITH, or VALUES statement before preparing it.
 */
function checkSql(sql: string) {
	let first = '';
	let ended = false;
	for (let at = 0; at < sql.length; ) {
		const char = sql[at] as string;
		if (/[\t\n\v\f\r ]/.test(char)) {
			at++;
			continue;
		}
		if (sql.startsWith('--', at)) {
			const end = sql.indexOf('\n', at + 2);
			at = end < 0 ? sql.length : end + 1;
			continue;
		}
		if (sql.startsWith('/*', at)) {
			const end = sql.indexOf('*/', at + 2);
			at = end < 0 ? sql.length : end + 2;
			continue;
		}
		if (char === ';') {
			ended = true;
			at++;
			continue;
		}
		if (ended)
			refuse(
				'A query reads with one SQL statement; more than one statement was given',
			);
		if (!first) {
			first = /^[A-Za-z]+/.exec(sql.slice(at))?.[0]?.toUpperCase() ?? char;
			if (!['SELECT', 'WITH', 'VALUES'].includes(first))
				refuse('A query only reads: use one SELECT, WITH, or VALUES statement');
		}
		if (char === "'" || char === '"' || char === '`' || char === '[') {
			const end = char === '[' ? ']' : char;
			at++;
			while (at < sql.length) {
				if (sql[at++] !== end) continue;
				if (char !== '[' && sql[at] === end) {
					at++;
					continue;
				}
				break;
			}
		} else at++;
	}
	if (!first) refuse('A query needs SQL');
}

function sqlValue(value: unknown): string | number | null {
	if (value === undefined || value === null) return null;
	if (typeof value === 'boolean') return Number(value);
	if (typeof value === 'string' || typeof value === 'number') return value;
	return JSON.stringify(value);
}

/**
 * Read every matching Markdown file into a throwaway in-memory SQLite database.
 * Tables and columns follow `queryTables`; a missing singleton has zero rows.
 * Arrays and objects are JSON text; booleans are 0/1. Problems and other are
 * JSON text, NULL when empty. `.local` collections and files are excluded.
 *
 * Each call rereads files, without a cache or an atomic snapshot of the folder.
 * A read-only deserialized database plus query_only enforce reads. Text checks
 * allow one SELECT/WITH/VALUES statement, and it must return distinct columns.
 * Throws QueryError.Refused for refused SQL, QueryError.Failed for SQLite errors.
 *
 * ```ts
 * const collections = { books, settings };
 * const unread = defineAction({
 *   description: 'Books I have not finished',
 *   input: { rating: field.integer({ optional: true }) },
 *   annotations: { readOnlyHint: true },
 *   run: ({ rating }) => query(collections, 'select path, title from books where finished is null and coalesce(rating, 0) >= ? order by title', [rating ?? 0]),
 * });
 * export default defineApp({ description: 'Books', collections, actions: { books: books.actions(), unread } });
 * ```
 */
export async function query(
	collections: Record<string, AnyCollection>,
	sql: string,
	params?: QueryParams,
): Promise<QueryRow[]> {
	checkSql(sql);
	// Throw outside a run, as collection methods do, even when no table reads a file.
	void folder.path;
	const tables = queryTables(collections);
	const records = await Promise.all(
		tables.map(({ table }) =>
			recordsOf(collections[table] as AnyCollection, table)(),
		),
	);
	let bytes: Uint8Array;
	const build = new Database(':memory:');
	try {
		build.transaction(() => {
			for (const [at, { table, columns, path }] of tables.entries()) {
				const required = new Set([
					'path',
					'body',
					...template(path).placeholders,
				]);
				build.run(
					`CREATE TABLE ${quote(table)} (${columns.map(({ name, type }) => `${quote(name)} ${DECLARED_TYPES[type]}${name === 'path' ? ' PRIMARY KEY' : ''}${required.has(name) ? ' NOT NULL' : ''}`).join(', ')}) WITHOUT ROWID`,
				);
				const insert = build.prepare(
					`INSERT INTO ${quote(table)} VALUES (${columns.map(() => '?').join(', ')})`,
				);
				try {
					for (const record of records[at] ?? [])
						insert.run(
							...columns.map(({ name }) => {
								const value = record[name];
								if (
									name === 'problems' &&
									Array.isArray(value) &&
									!value.length
								)
									return null;
								if (
									name === 'other' &&
									value &&
									typeof value === 'object' &&
									!Object.keys(value).length
								)
									return null;
								return sqlValue(value);
							}),
						);
				} finally {
					insert.finalize();
				}
			}
		})();
		bytes = build.serialize();
	} finally {
		build.close();
	}
	const db = Database.deserialize(bytes, { readonly: true, strict: true });
	try {
		db.run('PRAGMA query_only = ON');
		const statement = db.prepare<Record<string, unknown>, SQLQueryBindings[]>(
			sql,
		);
		try {
			const names = statement.columnNames;
			if (!names.length)
				refuse(
					'A query only reads and returns columns; this statement returns no rows',
				);
			if (new Set(names).size !== names.length)
				refuse(
					'Two result columns share a name; give one another name with AS',
				);
			const valueCount = params === undefined ? 0 : Object.keys(params).length;
			if (statement.paramsCount > 0 && valueCount === 0)
				throw QueryError.Failed({
					message: `This query has ${statement.paramsCount} parameters; give their values`,
				}).error;
			if (statement.paramsCount === 0 && valueCount > 0)
				throw QueryError.Failed({
					message: 'This query has no parameters; omit their values',
				}).error;
			const rows = Array.isArray(params)
				? statement.all(...params)
				: params === undefined
					? statement.all()
					: statement.all(params as Readonly<Record<string, QueryValue>>);
			for (const row of rows)
				for (const value of Object.values(row)) {
					if (value instanceof Uint8Array || typeof value === 'bigint')
						refuse(
							'A query answers text, numbers, and null; convert binary values to text',
						);
				}
			return rows as QueryRow[];
		} finally {
			statement.finalize();
		}
	} catch (error) {
		if (error instanceof SQLiteError) {
			if (error.code === 'SQLITE_READONLY')
				refuse('A query only reads; it cannot change the database');
			throw QueryError.Failed({ message: error.message }).error;
		}
		if (error instanceof Error)
			throw QueryError.Failed({ message: error.message }).error;
		throw error;
	} finally {
		db.close();
	}
}
