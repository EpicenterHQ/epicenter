/**
 * The browse read-models: a generic SQLite inspection surface over the mirror
 * artifact. The table list comes from `sqlite_master`, the column list from
 * `pragma_table_xinfo`, and the rows from explicit SELECTs, so the browse UI
 * renders whatever the database actually holds; the schema authority is the
 * DDL in the file (`MIRROR_SCHEMA`), not a TypeScript declaration. `queryBooks`
 * is the arbitrary-SQL surface beneath this, and `readBooksStatus` is the
 * connection-and-freshness read beside it. All three are read-only reads over
 * the same SQLite mirror.
 *
 * Like `queryBooks`, each opens a fresh read-only handle per call (cheap, and
 * it never blocks or is blocked by a concurrent sync's write lock).
 *
 * The SQL-identifier boundary: a request's table name is never interpolated.
 * It is resolved against `sqlite_master` first (a parameterized lookup), and
 * only the name the database itself returned is quoted into a statement, so an
 * unknown or hostile string ends at "no such table", never inside SQL.
 */

import type { Database } from 'bun:sqlite';
import type { DbFile } from '../db-file.ts';

/** One column as `pragma_table_xinfo` reports it. */
export type TableColumn = {
	name: string;
	/** The declared type from the DDL, e.g. `TEXT`, `INTEGER`, `REAL`. */
	type: string;
	/** Part of the primary key. */
	pk: boolean;
	/** A GENERATED column (projected from `raw`, not stored by a writer). */
	generated: boolean;
};

/** One table in the browse list: its columns and row count. */
export type TableSummary = {
	name: string;
	rowCount: number;
	/** The single-column primary key, or null (composite or none: rowid rules). */
	pk: string | null;
	columns: TableColumn[];
};

/** A page of one table's rows plus the total for pagination. */
export type TableRowsPage = {
	table: string;
	pk: string | null;
	columns: TableColumn[];
	rows: Record<string, unknown>[];
	total: number;
	limit: number;
	offset: number;
};

/** One row's full column values, with the columns for type-aware rendering. */
export type TableRowDetail = {
	table: string;
	pk: string | null;
	columns: TableColumn[];
	values: Record<string, unknown>;
};

/** Quote an identifier for interpolation. Only sqlite_master-resolved names. */
function quoted(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/** The canonical table name from `sqlite_master`, or null when unknown. */
function resolveTable(db: Database, requested: string): string | null {
	const row = db
		.query<{ name: string }, [string]>(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name = ?`,
		)
		.get(requested);
	return row?.name ?? null;
}

function tableColumns(db: Database, table: string): TableColumn[] {
	const rows = db
		.query<
			{ name: string; type: string; pk: number; hidden: number },
			[string]
		>(`SELECT name, type, pk, hidden FROM pragma_table_xinfo(?)`)
		.all(table);
	return rows.map((c) => ({
		name: c.name,
		type: c.type,
		pk: c.pk > 0,
		generated: c.hidden === 2 || c.hidden === 3,
	}));
}

/** The single-column primary key, or null: rowid addresses the rest. */
function singlePk(columns: TableColumn[]): string | null {
	const pks = columns.filter((c) => c.pk);
	return pks.length === 1 ? (pks[0]?.name ?? null) : null;
}

/**
 * Newest-first where the table records recency, else primary-key order, so
 * paging is deterministic without knowing anything about the table beforehand.
 */
function orderClause(columns: TableColumn[]): string {
	if (columns.some((c) => c.name === 'updated_at')) {
		return ` ORDER BY "updated_at" DESC`;
	}
	const pk = singlePk(columns);
	return pk === null ? '' : ` ORDER BY ${quoted(pk)}`;
}

/**
 * Every table in the mirror, in creation (schema) order, with its columns and
 * row count. "Mirror not built yet" is a reported state (`mirrorBuilt: false`,
 * empty list), not an error, matching `readBooksStatus`.
 */
export function listTables({ mirror }: { mirror: DbFile }): {
	mirrorBuilt: boolean;
	tables: TableSummary[];
} {
	const db = mirror.openReadonly();
	if (db === null) return { mirrorBuilt: false, tables: [] };
	try {
		const names = db
			.query<{ name: string }, []>(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
			)
			.all()
			.map((r) => r.name);
		const tables = names.map((name) => {
			const columns = tableColumns(db, name);
			const rowCount =
				db
					.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${quoted(name)}`)
					.get()?.n ?? 0;
			return { name, rowCount, pk: singlePk(columns), columns };
		});
		return { mirrorBuilt: true, tables };
	} finally {
		db.close();
	}
}

/**
 * A page of one table's rows via `SELECT *`, so generated columns project and
 * nothing is curated away. `null` when the table does not exist (in the mirror
 * or at all).
 */
export function pageTableRows({
	mirror,
	table,
	limit,
	offset,
}: {
	mirror: DbFile;
	table: string;
	limit: number;
	offset: number;
}): TableRowsPage | null {
	const db = mirror.openReadonly();
	if (db === null) return null;
	try {
		const resolved = resolveTable(db, table);
		if (resolved === null) return null;
		const columns = tableColumns(db, resolved);
		const total =
			db
				.query<{ n: number }, []>(
					`SELECT count(*) AS n FROM ${quoted(resolved)}`,
				)
				.get()?.n ?? 0;
		const rows = db
			.query(
				`SELECT * FROM ${quoted(resolved)}${orderClause(columns)} LIMIT ? OFFSET ?`,
			)
			.all(limit, offset) as Record<string, unknown>[];
		return {
			table: resolved,
			pk: singlePk(columns),
			columns,
			rows,
			total,
			limit,
			offset,
		};
	} finally {
		db.close();
	}
}

/**
 * One row's full column values, addressed by the table's single-column primary
 * key (or rowid when there is none). `null` when the table or row is unknown.
 */
export function getTableRow({
	mirror,
	table,
	id,
}: {
	mirror: DbFile;
	table: string;
	id: string;
}): TableRowDetail | null {
	const db = mirror.openReadonly();
	if (db === null) return null;
	try {
		const resolved = resolveTable(db, table);
		if (resolved === null) return null;
		const columns = tableColumns(db, resolved);
		const pk = singlePk(columns);
		const keyColumn = pk === null ? 'rowid' : quoted(pk);
		const row = db
			.query(`SELECT * FROM ${quoted(resolved)} WHERE ${keyColumn} = ?`)
			.get(id) as Record<string, unknown> | null;
		if (!row) return null;
		return { table: resolved, pk, columns, values: row };
	} finally {
		db.close();
	}
}
