/** Restricted statements use fresh C-API prepares and restore connection policy. */
import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import {
	QUERY_FUNCTIONS,
	QUERY_LIMITS,
	type QueryOptions,
	type QueryResult,
	type QueryValue,
} from './query.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const functions = new Set<string>(QUERY_FUNCTIONS);
const jsonTables = new Set(['json_each', 'json_tree']);

/** The owner serializes this runner with every other operation on the database. */
export function createBrowserQuery(sqlite: Sqlite3Static, database: Database) {
	const { capi: c, wasm: w } = sqlite;
	// Installed runtime accepts null pointers; its declaration omits that overload.
	const authorize = c.sqlite3_set_authorizer as (
		db: Database,
		callback: Parameters<typeof c.sqlite3_set_authorizer>[1] | 0,
		argument: number,
	) => number;

	return async function query(
		sql: string,
		options: QueryOptions,
	): Promise<QueryResult> {
		options.signal?.throwIfAborted();
		if (
			sql.includes('\0') ||
			encoder.encode(sql).length > QUERY_LIMITS.sqlBytes
		)
			throw new Error('SQL exceeds its byte limit or contains NUL.');
		const tables = new Set(options.tables.map((name) => name.toLowerCase()));
		// COUNT(*) may report a physical relation without its schema. Inventory
		// every attached schema so a CTE can be distinguished from a private table.
		const physical = new Set<string>();
		const outsideMain = new Set<string>();
		const relations = new Set<string>();
		const schemas = database.exec({
			sql: 'PRAGMA database_list',
			rowMode: 'object',
			returnValue: 'resultRows',
		});
		for (const schema of new Set([
			'main',
			'temp',
			...schemas.map((row) => String(row.name)),
		])) {
			const rows = database.exec({
				sql: `SELECT name FROM "${schema.replaceAll('"', '""')}".sqlite_schema`,
				rowMode: 'object',
				returnValue: 'resultRows',
			});
			for (const row of rows) {
				const name = String(row.name).toLowerCase();
				physical.add(name);
				relations.add(name);
				if (schema !== 'main') outsideMain.add(name);
			}
		}
		for (const row of database.exec({
			sql: 'PRAGMA module_list',
			rowMode: 'object',
			returnValue: 'resultRows',
		}))
			physical.add(String(row.name).toLowerCase());
		for (const name of [
			'sqlite_master',
			'sqlite_schema',
			'sqlite_temp_master',
			'sqlite_temp_schema',
		])
			physical.add(name);

		// Initializing an eponymous module consults its schema. Do this before
		// restrictions, and never mistake a physical table for that module.
		for (const name of jsonTables) {
			if (!relations.has(name))
				database.exec(`SELECT value FROM main.${name}('[]')`);
		}

		const deadline = performance.now() + QUERY_LIMITS.deadlineMs;
		let operations = 0;
		let interrupted = false;
		function expired() {
			return (
				options.signal?.aborted ||
				performance.now() >= deadline ||
				operations >= QUERY_LIMITS.vmOperations
			);
		}
		function check(code: number) {
			if (code !== c.SQLITE_OK) {
				if (interrupted || expired())
					throw new Error('Query cancelled or execution limit exceeded.');
				throw new Error(`SQLite ${code}: ${c.sqlite3_errmsg(database)}`);
			}
		}
		const limits = [
			[c.SQLITE_LIMIT_LENGTH, QUERY_LIMITS.valueBytes],
			[c.SQLITE_LIMIT_SQL_LENGTH, QUERY_LIMITS.sqlBytes],
			[c.SQLITE_LIMIT_COLUMN, QUERY_LIMITS.columns],
		] as const;
		const previous = limits.map(([id, value]) =>
			c.sqlite3_limit(database, id, value),
		);
		let source = 0;
		let output = 0;
		let tail = 0;
		let statement = 0;
		try {
			check(
				authorize(
					database,
					(_arg, action, relation, column, schema) => {
						if (action === c.SQLITE_SELECT || action === c.SQLITE_RECURSIVE)
							return c.SQLITE_OK;
						if (
							action === c.SQLITE_FUNCTION &&
							functions.has(String(column).toLowerCase())
						)
							return c.SQLITE_OK;
						if (action === c.SQLITE_READ) {
							const name = String(relation).toLowerCase();
							const admitted =
								tables.has(name) ||
								(jsonTables.has(name) && !relations.has(name));
							if (schema === 'main' && admitted) return c.SQLITE_OK;
							if (
								!schema &&
								column === '' &&
								!outsideMain.has(name) &&
								(admitted ||
									(!physical.has(name) && !name.startsWith('pragma_')))
							)
								return c.SQLITE_OK;
						}
						return c.SQLITE_DENY;
					},
					0,
				),
			);
			c.sqlite3_progress_handler(
				database,
				QUERY_LIMITS.progressInterval,
				() => {
					operations += QUERY_LIMITS.progressInterval;
					interrupted = Boolean(expired());
					return interrupted ? 1 : 0;
				},
				0,
			);
			let length: number;
			[source, length] = w.allocCString(sql, true);
			output = w.allocPtr(1);
			tail = w.allocPtr(1);
			const prepared = c.sqlite3_prepare_v3(
				database,
				source,
				length + 1,
				0,
				output,
				tail,
			);
			statement = w.peekPtr(output);
			check(prepared);
			if (!statement) throw new Error('One SQL statement is required.');
			let cursor = w.peekPtr(tail);
			while (cursor < source + length) {
				w.pokePtr(output, 0);
				const code = c.sqlite3_prepare_v3(
					database,
					cursor,
					source + length - cursor + 1,
					0,
					output,
					tail,
				);
				const extra = w.peekPtr(output);
				if (extra) c.sqlite3_finalize(extra);
				check(code);
				if (extra) throw new Error('Only one SQL statement is permitted.');
				const next = w.peekPtr(tail);
				if (next <= cursor) throw new Error('SQL parser made no progress.');
				cursor = next;
			}
			if (!c.sqlite3_stmt_readonly(statement))
				throw new Error('Only read-only SQL is permitted.');
			const parameters = options.parameters ?? [];
			if (parameters.length !== c.sqlite3_bind_parameter_count(statement))
				throw new Error('SQL parameter count does not match.');
			for (const [index, value] of parameters.entries()) {
				const position = index + 1;
				// A fresh statement already binds every parameter to NULL.
				if (value === null) continue;
				else if (typeof value === 'number') {
					if (!Number.isFinite(value))
						throw new Error('SQL parameters must be finite.');
					check(
						Number.isSafeInteger(value)
							? c.sqlite3_bind_int64(statement, position, BigInt(value))
							: c.sqlite3_bind_double(statement, position, value),
					);
				} else if (typeof value === 'string') {
					if (encoder.encode(value).length > QUERY_LIMITS.valueBytes)
						throw new Error('SQL parameter exceeds the value limit.');
					const [pointer, length] = w.allocCString(value, true);
					try {
						check(
							c.sqlite3_bind_text(
								statement,
								position,
								pointer,
								length,
								c.SQLITE_TRANSIENT,
							),
						);
					} finally {
						w.dealloc(pointer);
					}
				} else {
					if (value.byteLength > QUERY_LIMITS.valueBytes)
						throw new Error('SQL parameter exceeds the value limit.');
					check(
						c.sqlite3_bind_blob(
							statement,
							position,
							value,
							value.byteLength,
							c.SQLITE_TRANSIENT,
						),
					);
				}
			}
			const columns = Array.from(
				{ length: c.sqlite3_column_count(statement) },
				(_, index) => c.sqlite3_column_name(statement, index),
			);
			if (!columns.length)
				throw new Error('The statement must return columns.');
			const rows: QueryValue[][] = [];
			let bytes = encoder.encode(
				JSON.stringify({ columns, rows: [], truncated: false }),
			).length;
			if (
				bytes > QUERY_LIMITS.resultBytes ||
				columns.some(
					(column) => encoder.encode(column).length > QUERY_LIMITS.sqlBytes,
				)
			)
				throw new Error('Query columns exceed the result byte limit.');
			for (;;) {
				if (expired())
					throw new Error('Query cancelled or execution limit exceeded.');
				const code = c.sqlite3_step(statement);
				if (code === c.SQLITE_DONE) return { columns, rows, truncated: false };
				if (code !== c.SQLITE_ROW) check(code);
				if (rows.length >= QUERY_LIMITS.rows)
					return { columns, rows, truncated: true };
				const row = columns.map((_, index): QueryValue => {
					const type = c.sqlite3_column_type(statement, index);
					if (type === c.SQLITE_NULL) return null;
					if (type === c.SQLITE_INTEGER)
						return {
							integer: c.sqlite3_column_int64(statement, index).toString(),
						};
					if (type === c.SQLITE_FLOAT) {
						const value = c.sqlite3_column_double(statement, index);
						if (!Number.isFinite(value))
							throw new Error('Query returned a non-finite real value.');
						return value;
					}
					// Reading explicit bytes also preserves NUL characters inside TEXT.
					const pointer = c.sqlite3_column_blob(statement, index);
					const length = c.sqlite3_column_bytes(statement, index);
					if (length > QUERY_LIMITS.valueBytes)
						throw new Error('Query value exceeds the byte limit.');
					const value = w.heap8u().subarray(pointer, pointer + length);
					return type === c.SQLITE_TEXT
						? decoder.decode(value)
						: {
								blob: Array.from(value, (byte) =>
									byte.toString(16).padStart(2, '0'),
								).join(''),
							};
				});
				bytes +=
					encoder.encode(JSON.stringify(row)).length + (rows.length ? 1 : 0);
				if (bytes > QUERY_LIMITS.resultBytes)
					return { columns, rows, truncated: true };
				rows.push(row);
				if (rows.length % 32 === 0)
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		} finally {
			if (statement) c.sqlite3_finalize(statement);
			c.sqlite3_progress_handler(database, 0, 0, 0);
			authorize(database, 0, 0);
			for (const [index, [id]] of limits.entries())
				c.sqlite3_limit(database, id, previous[index]!);
			w.dealloc(source);
			w.dealloc(output);
			w.dealloc(tail);
		}
	};
}
