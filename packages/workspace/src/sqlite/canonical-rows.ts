import {
	foldFields,
	isAdmissibleCanonicalRow,
	type WireRowIntent,
} from '@epicenter/row-sync';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type ConstrainedChanges,
	type CreateInputFor,
	compileTableLens,
	type JsonObject,
	type RowFor,
	type RowLensError,
	type TableLensDefinition,
	type TableLensDefinitions,
} from './lens-definition.js';
import { listLocalRows, readLocalRow } from './local-workspace-storage.js';

const ROWS_TABLE = 'rows';
const ROW_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const mintRowId = customAlphabet(ROW_ID_ALPHABET, 24);

export type CanonicalTable<TDefinition extends TableLensDefinition> = {
	/** Read and project one current row through this release's lens. */
	get(id: string): Result<RowFor<TDefinition> | undefined, RowLensError>;
	/** List every current row, partitioned by release-lens conformance. */
	list(): {
		rows: RowFor<TDefinition>[];
		nonconforming: RowLensError[];
	};
	/** Validate complete fields and allocate the row's structural id. */
	create(fields: CreateInputFor<TDefinition>): RowFor<TDefinition>;
	/** Validate and apply supplied absolute field changes. */
	update<const TChanges extends Record<string, unknown>>(
		id: string,
		changes: TChanges & ConstrainedChanges<TDefinition, TChanges>,
	): Result<RowFor<TDefinition> | undefined, RowLensError>;
	delete(id: string): void;
};

export type CanonicalTables<TTables extends TableLensDefinitions> = {
	[K in keyof TTables]: CanonicalTable<TTables[K]>;
};

export type CanonicalRowsOptions = {
	/** Synchronized mode admits durable RowIntents instead of mutating confirmed rows. */
	admitIntent?(intent: WireRowIntent): void;
	/** Read confirmed state plus any synchronized optimistic overlay. */
	readCurrentRow?(table: string, rowId: string): JsonObject | undefined;
	onLocalCommit?(): void;
	/**
	 * Delete durable document logs inside the local-mode delete transaction,
	 * so scalar death and document death commit together. Synchronized mode
	 * never calls this; the replica owns its own lifecycle transactions.
	 */
	deleteDocumentRows?(addresses: readonly { table: string; rowId: string }[]): void;
	/** Revoke cached row documents as soon as local deletion changes liveness. */
	onRowsDeleted?(addresses: { table: string; rowId: string }[]): void;
};

/** Open release-local table lenses over the canonical four-table SQLite owner. */
export function createCanonicalRows<const TTables extends TableLensDefinitions>(
	sqlite: SqliteDatabase,
	definitions: TTables,
	{
		admitIntent,
		readCurrentRow = (table, rowId) => readLocalRow(sqlite, table, rowId),
		onLocalCommit = () => undefined,
		deleteDocumentRows = () => undefined,
		onRowsDeleted = () => undefined,
	}: CanonicalRowsOptions = {},
) {
	assertDefinitions(definitions);
	installTemporaryViews(sqlite, definitions);

	const tables = Object.fromEntries(
		Object.entries(definitions).map(([tableName, definition]) => {
			const lens = compileTableLens(definition);
			const table = {
				get(id: string) {
					const fields = readCurrentRow(tableName, id);
					return fields === undefined
						? Ok(undefined)
						: lens.project(tableName, id, fields);
				},
				list() {
					const rows: Record<string, unknown>[] = [];
					const nonconforming: RowLensError[] = [];
					for (const current of listRows(tableName)) {
						const result = lens.project(
							tableName,
							current.rowId,
							current.fields,
						);
						if (result.error === null) rows.push(result.data);
						else nonconforming.push(result.error);
					}
					return { rows, nonconforming };
				},
				create(input: Record<string, unknown>) {
					const fields = lens.validateCreate(input);
					const id = mintRowId();
					if (
						!isAdmissibleCanonicalRow({ table: tableName, rowId: id, fields })
					) {
						throw new RangeError(
							'Canonical row exceeds portable row-sync limits',
						);
					}
					const intent = {
						kind: 'create',
						table: tableName,
						rowId: id,
						fields,
					} satisfies WireRowIntent;
					if (admitIntent) admitIntent(structuredClone(intent));
					else {
						sqlite.run(
							`INSERT INTO "${ROWS_TABLE}"(table_key, row_id, fields_json)
							 VALUES (?, ?, ?)`,
							[tableName, id, JSON.stringify(fields)],
						);
						onLocalCommit();
					}
					return expectConforming(lens.project(tableName, id, fields));
				},
				update(id: string, changes: Record<string, unknown>) {
					const normalized = lens.normalizeChanges(changes);
					const current = readCurrentRow(tableName, id);
					if (
						Object.keys(normalized.set).length === 0 &&
						normalized.unset.length === 0
					) {
						return current === undefined
							? Ok(undefined)
							: lens.project(tableName, id, current);
					}
					const intent = {
						kind: 'update',
						table: tableName,
						rowId: id,
						fields: normalized,
					} satisfies WireRowIntent;
					if (admitIntent) admitIntent(structuredClone(intent));
					else {
						const folded = foldFields(current, intent);
						if (folded.kind === 'fields') {
							sqlite.run(
								`UPDATE "${ROWS_TABLE}" SET fields_json = ?
								 WHERE table_key = ? AND row_id = ?`,
								[JSON.stringify(folded.fields), tableName, id],
							);
							onLocalCommit();
						}
					}
					const projected = readCurrentRow(tableName, id);
					return projected === undefined
						? Ok(undefined)
						: lens.project(tableName, id, projected);
				},
				delete(id: string) {
					const intent = {
						kind: 'delete',
						table: tableName,
						rowId: id,
					} satisfies WireRowIntent;
					if (admitIntent) admitIntent(intent);
					else {
						sqlite.transaction(() => {
							sqlite.run(
								`DELETE FROM "${ROWS_TABLE}"
								 WHERE table_key = ? AND row_id = ?`,
								[tableName, id],
							);
							deleteDocumentRows([{ table: tableName, rowId: id }]);
						});
						onLocalCommit();
					}
					onRowsDeleted([{ table: tableName, rowId: id }]);
				},
			};
			return [tableName, table];
		}),
	) as CanonicalTables<TTables>;

	return {
		tables,
		/** Execute one validated read-only SELECT against current lens views. */
		sql<TResultSchema extends TSchema>(
			query: string,
			parameters: readonly SqliteValue[],
			resultSchema: TResultSchema,
		): Static<TResultSchema>[] {
			assertSelectStatement(query);
			refreshTemporaryProjections(sqlite, definitions, listRows);
			sqlite.run('PRAGMA query_only = ON');
			try {
				const rows = sqlite.all<SqliteRow>(query, parameters);
				for (const [index, row] of rows.entries()) {
					if (!Value.Check(resultSchema, row)) {
						const issues = [...Value.Errors(resultSchema, row)]
							.map((issue) => `${issue.instancePath}: ${issue.message}`)
							.join('; ');
						throw new TypeError(
							`SQL row ${index} does not satisfy the result schema: ${issues}`,
						);
					}
				}
				return rows as Static<TResultSchema>[];
			} finally {
				sqlite.run('PRAGMA query_only = OFF');
			}
		},
	};

	function listRows(table: string): { rowId: string; fields: JsonObject }[] {
		if (!admitIntent) return listLocalRows(sqlite, table);
		const rowIds = sqlite.all<{ row_id: string }>(
			`SELECT row_id FROM "${ROWS_TABLE}" WHERE table_key = ?
			 UNION
			 SELECT row_id FROM "intents" WHERE table_key = ?
			 ORDER BY row_id`,
			[table, table],
		);
		return rowIds.flatMap(({ row_id: rowId }) => {
			const fields = readCurrentRow(table, rowId);
			return fields === undefined ? [] : [{ rowId, fields }];
		});
	}
}

export type CanonicalRows<
	TTables extends TableLensDefinitions = TableLensDefinitions,
> = ReturnType<typeof createCanonicalRows<TTables>>;

function expectConforming<TResult>(
	result: Result<TResult, RowLensError>,
): TResult {
	if (result.error !== null) throw new Error(result.error.message);
	return result.data;
}

function assertDefinitions(definitions: TableLensDefinitions): void {
	if (!isPlainObject(definitions)) {
		throw new TypeError('Table lenses must be a plain object');
	}
	const sqliteNames = new Set<string>();
	for (const [name, definition] of Object.entries(definitions)) {
		assertSqlName(name, 'table name');
		const sqliteName = name.toLowerCase();
		if (sqliteNames.has(sqliteName)) {
			throw new Error(`Table '${name}' collides with another table in SQLite`);
		}
		sqliteNames.add(sqliteName);
		compileTableLens(definition);
	}
}

function projectionTableName(table: string): string {
	return `__epicenter_projection_${table}`;
}

function installTemporaryViews(
	sqlite: SqliteDatabase,
	definitions: TableLensDefinitions,
): void {
	for (const [tableName, definition] of Object.entries(definitions)) {
		const projection = projectionTableName(tableName);
		sqlite.run(`DROP VIEW IF EXISTS temp.${quoteIdentifier(tableName)}`);
		sqlite.run(
			`CREATE TEMP TABLE IF NOT EXISTS ${quoteIdentifier(projection)} (
				row_id TEXT PRIMARY KEY,
				fields_json TEXT NOT NULL CHECK(json_valid(fields_json))
			) WITHOUT ROWID, STRICT`,
		);
		const lens = compileTableLens(definition);
		const columns = [
			'"row_id" AS "id"',
			...[...lens.fields.values()].map(projectedSqlColumn),
		];
		sqlite.run(
			`CREATE TEMP VIEW ${quoteIdentifier(tableName)} AS
			 SELECT ${columns.join(', ')} FROM ${quoteIdentifier(projection)}`,
		);
	}
}

function refreshTemporaryProjections(
	sqlite: SqliteDatabase,
	definitions: TableLensDefinitions,
	listRows: (table: string) => { rowId: string; fields: JsonObject }[],
): void {
	sqlite.transaction(() => {
		for (const tableName of Object.keys(definitions)) {
			const projection = projectionTableName(tableName);
			sqlite.run(`DELETE FROM temp.${quoteIdentifier(projection)}`);
			for (const row of listRows(tableName)) {
				sqlite.run(
					`INSERT INTO temp.${quoteIdentifier(projection)}(row_id, fields_json)
					 VALUES (?, ?)`,
					[row.rowId, JSON.stringify(row.fields)],
				);
			}
		}
	});
}

function projectedSqlColumn(field: {
	name: string;
	kind: import('@epicenter/field').Kind;
}): string {
	const path = quoteSqlLiteral(`$.${field.name}`);
	const jsonTypes = sqlJsonTypes(field.kind).map(quoteSqlLiteral).join(', ');
	return `CASE WHEN json_type("fields_json", ${path}) IN (${jsonTypes}) THEN json_extract("fields_json", ${path}) ELSE NULL END AS ${quoteIdentifier(field.name)}`;
}

function sqlJsonTypes(
	kind: import('@epicenter/field').Kind,
): readonly string[] {
	switch (kind) {
		case 'string':
		case 'url':
		case 'date':
		case 'datetime':
		case 'instant':
		case 'select':
		case 'reference':
			return ['text'];
		case 'integer':
			return ['integer'];
		case 'number':
			return ['integer', 'real'];
		case 'boolean':
			return ['true', 'false'];
		case 'tags':
		case 'multiSelect':
			return ['array'];
		case 'json':
			return [
				'null',
				'text',
				'integer',
				'real',
				'true',
				'false',
				'array',
				'object',
			];
		default:
			return kind satisfies never;
	}
}

function assertSelectStatement(query: string): void {
	const trimmed = query.trim();
	if (!/^SELECT(?:\s|$)/i.test(trimmed)) {
		throw new Error('sql() accepts only SELECT statements');
	}
	if (trimmed.includes(';')) {
		throw new Error('sql() accepts exactly one statement');
	}
	if (/(?:__epicenter|sqlite_|pragma_)/i.test(trimmed)) {
		throw new Error('sql() cannot access runtime-private storage');
	}
}

function assertSqlName(value: string, label: string): void {
	if (
		!/^[A-Za-z][A-Za-z0-9_]*$/.test(value) ||
		value.startsWith('__epicenter_') ||
		value.toLowerCase().startsWith('sqlite_')
	) {
		throw new Error(
			`Invalid ${label} '${value}'; use letters, digits, and underscores and do not use reserved SQLite or internal prefixes`,
		);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
