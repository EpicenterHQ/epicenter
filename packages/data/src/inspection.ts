/**
 * Native relational inspection over one live Epicenter (ADR-0162).
 *
 * The product sentence: Home runs ordinary read-only SQLite against a live
 * Epicenter as though the selected Lens's logical tables were SQLite tables,
 * including a literal `SELECT * FROM notes`. Not a dialect, not a query builder,
 * not a subset: real SQLite, with real joins, aggregates, and expressions.
 *
 * Three decisions carry that:
 *
 * A dedicated connection. Inspection opens its own `bun:sqlite` handle on the
 * same file with `readonly: true` and never borrows the store owner's writable
 * one. Read-only at open is the write boundary, so there is no toggle to forget
 * to restore and no window where submitted SQL runs against a writable handle.
 * A connection cannot even promote itself: `PRAGMA journal_mode = WAL` fails on
 * a read-only handle like any other write.
 *
 * Connection-local views. The raw relations and the friendly Lens tables are
 * `TEMP` views, which live in this connection's own `temp` schema. The owner
 * connection cannot see them, so nothing installed for inspection can redirect
 * an internal read; closing the connection discards them with no cleanup step.
 *
 * Present rows only, in the friendly views. `SELECT * FROM notes` answers "what
 * are my notes", and a tombstone is not a note. Deleted rows stay inspectable
 * through `_epicenter_rows`, where `presence` is a column and absence is the
 * honest answer rather than a hidden filter.
 *
 * What this is not: read-only stops mutation, not expense. A submitted query can
 * still be slow or scan the whole store. This is a trusted-host capability with
 * bounded results, not a sandbox for hostile SQL, and applications receive no
 * SQL at all.
 *
 * Row documents and blobs are deliberately absent from V1. Nothing here projects
 * document bytes, and the raw relations are not a complete portable artifact.
 */
import { Database } from 'bun:sqlite';
import type { SqliteValue } from '@epicenter/sqlite';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, trySync } from 'wellcrafted/result';

import type { Lens } from './definitions.js';

/** Rows returned to the host. Column names come from the submitted SQL. */
export type InspectionRow = Record<string, SqliteValue | ArrayBuffer>;

export type InspectionResult = {
	rows: InspectionRow[];
	/**
	 * Whether the bound stopped the result short. The rows returned are correct
	 * and complete up to the bound; there were simply more.
	 */
	truncated: boolean;
};

export const InspectionError = defineErrors({
	OpenFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `Could not open '${path}' for inspection: ${extractErrorMessage(cause)}`,
		path,
		cause,
	}),
	Closed: () => ({ message: 'This inspection connection is closed' }),
	/**
	 * The submitted SQL failed. Deliberately one variant: a syntax error, an
	 * unknown table, and an attempted write are all "your query did not run", and
	 * SQLite's own message says which far better than a taxonomy would.
	 */
	QueryFailed: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type InspectionError = InferErrors<typeof InspectionError>;

/**
 * How much one statement may return.
 *
 * A row ceiling alone is not enough, because one row can hold a large JSON
 * payload, so the byte ceiling stops a small number of very large rows too.
 */
export type InspectionBounds = {
	maxRows: number;
	maxResultBytes: number;
};

export const DEFAULT_INSPECTION_BOUNDS: InspectionBounds = {
	maxRows: 1_000,
	maxResultBytes: 8 * 1024 * 1024,
};

/**
 * How long a read waits for a writer's commit before giving up.
 *
 * The owner's writes are short transactions, and a reader only ever blocks for
 * the brief exclusive moment of a commit, so a small timeout absorbs normal
 * contention. This is why inspection needs no journal-mode change: an ordinary
 * rollback-journal database serves a concurrent reader fine.
 */
const BUSY_TIMEOUT_MS = 2_000;

/** Quote one identifier for SQL. Doubling is SQLite's own escape. */
function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/** Quote one string literal for SQL. Doubling is SQLite's own escape. */
function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The SQL for one declared field.
 *
 * A friendly view is a Lens-addressed extraction, not a second validator.
 * Whatever is stored appears as SQLite's natural JSON extraction type, including
 * a value that does not conform to the selected Lens. Complete conformance stays
 * owned by the typed Lens API, which can report structured issues instead of
 * collapsing them into SQL NULL.
 *
 * Field names are constrained to `[A-Za-z][A-Za-z0-9_]*` at declaration, which
 * makes the generated JSON path safe to build by concatenation. The column alias
 * remains quoted because quoting an identifier costs nothing.
 */
function fieldColumnSql(fieldName: string): string {
	const path = `'$.${fieldName}'`;
	return `json_extract(f.fields, ${path}) AS ${quoteIdentifier(fieldName)}`;
}

/**
 * The two reserved raw relations, which exist for every inspection connection
 * whether or not a Lens is selected.
 *
 * These are a logical contract, not a promise about physical storage: the column
 * names are the structured coordinates, and `presence` is exposed because
 * absence is real state. A row tombstone and an unset value are both visible
 * here, which is what makes this the honest fallback when a Lens interpretation
 * cannot represent what is stored.
 *
 * They read the materialized visible projection rather than the fact relations,
 * so inspection shows what the application sees: a row created locally is in the
 * table before it settles, and one deleted locally is gone. Reading the fact
 * relations would show authority truth instead, which is a different and much
 * less useful question for someone querying their own data.
 */
const RAW_VIEWS = [
	`CREATE TEMP VIEW _epicenter_rows AS
		SELECT namespace, table_name, row_id, presence, fields AS fields_json
		FROM main._replica_v1_visible_rows`,
	`CREATE TEMP VIEW _epicenter_values AS
		SELECT namespace, value_name, presence, content AS content_json
		FROM main._replica_v1_visible_values`,
] as const;

const textEncoder = new TextEncoder();

/**
 * An upper bound on the JSON size of one cell, without encoding it.
 *
 * The bound exists to protect the host from a large response, so it has to
 * measure what actually crosses the boundary and must never read low. Binary is
 * where those two things diverge sharply: `bun:sqlite` returns a BLOB as a
 * `Uint8Array`, and `JSON.stringify` renders that as an index-keyed object, so
 * 32 bytes of BLOB become 268 bytes of JSON. Counting `byteLength` would
 * undercount the response roughly eightfold, and counting the value as `{}`, as
 * a naive `JSON.stringify` of an `ArrayBuffer` does, would report nearly zero
 * for an arbitrarily large payload.
 *
 * So binary is charged its worst-case rendered size: per element, the quoted
 * index, a colon, up to three digits of value, and a separator. Bounded above
 * without touching the bytes, which keeps the measurement O(1) per cell.
 */
function cellBytes(value: InspectionRow[string]): number {
	if (value === null) return 4;
	if (typeof value === 'number') return String(value).length;
	if (typeof value === 'string') {
		// The encoded text plus its two quotes. Escaping can add more, so this is
		// a floor for pathological strings; the row ceiling bounds those.
		return textEncoder.encode(value).byteLength + 2;
	}
	const length = value.byteLength;
	if (length === 0) return 2;
	const indexDigits = String(length - 1).length;
	// `{` + `}` and, per element, `"<index>":<value>` plus one separator.
	return 2 + length * (indexDigits + 2 + 1 + 3 + 1);
}

/**
 * An upper bound on the JSON size of one row, including its keys.
 *
 * Exported because it defines the bound's accounting, which is a contract worth
 * pinning directly rather than inferring by bisecting a ceiling.
 */
export function measureRowBytes(row: InspectionRow): number {
	let bytes = 2;
	for (const [column, value] of Object.entries(row)) {
		// `"<column>":<value>` plus one separator.
		bytes += textEncoder.encode(column).byteLength + 3 + cellBytes(value) + 1;
	}
	return bytes;
}

/**
 * Read rows from a live statement, stopping as soon as a bound would be crossed.
 *
 * The bound has to hold before the rows exist, not after. Calling `all()` first
 * and trimming the array afterwards lets SQLite materialize the entire result
 * into memory, so a query returning millions of rows exhausts the host before
 * either ceiling is consulted; the ceilings then only trim what already fits.
 * Stepping the statement means the work stops at the bound.
 *
 * `truncated` stays exact. Reaching `maxRows` is not itself truncation, because
 * a result of exactly that size is complete, so the loop reads one further row
 * to learn whether another exists. That is the only over-read, and the
 * remainder is never stepped.
 */
export function readBounded(
	rows: Iterable<InspectionRow>,
	bounds: InspectionBounds,
): InspectionResult {
	const taken: InspectionRow[] = [];
	// The two brackets of the JSON array the host will serialize.
	let bytes = 2;
	for (const row of rows) {
		if (taken.length >= bounds.maxRows) return { rows: taken, truncated: true };
		// The row plus the comma separating it from the previous one.
		const next = measureRowBytes(row) + (taken.length === 0 ? 0 : 1);
		if (bytes + next > bounds.maxResultBytes) {
			return { rows: taken, truncated: true };
		}
		bytes += next;
		taken.push(row);
	}
	return { rows: taken, truncated: false };
}

/**
 * Open one read-only inspection connection on a live Epicenter file.
 *
 * The caller owns the lifetime and must `close()`. Nothing here is reachable
 * from an application: the trusted native host decides who may inspect.
 */
export function openInspection({
	path,
	bounds = DEFAULT_INSPECTION_BOUNDS,
}: {
	path: string;
	bounds?: InspectionBounds;
}): Result<Inspection, InspectionError> {
	return trySync({
		try: () => {
			const database = new Database(path, { readonly: true });
			try {
				database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
				for (const statement of RAW_VIEWS) database.run(statement);
				return createInspection(database, bounds);
			} catch (cause) {
				database.close();
				throw cause;
			}
		},
		catch: (cause) => InspectionError.OpenFailed({ path, cause }),
	});
}

function createInspection(database: Database, bounds: InspectionBounds) {
	/** The table names currently mounted as friendly views, in mount order. */
	let mounted: string[] = [];
	let selected: string | undefined;
	let isClosed = false;

	function requireOpen(): void {
		if (isClosed) throw new Error('This inspection connection is closed');
	}

	function dropFriendlyViews(): void {
		for (const tableName of mounted) {
			database.run(`DROP VIEW IF EXISTS temp.${quoteIdentifier(tableName)}`);
		}
		mounted = [];
		selected = undefined;
	}

	return {
		/**
		 * Mount one Lens's tables as friendly views on this connection.
		 *
		 * Exactly one interpretation is selected at a time. Selecting a different
		 * Lens drops the previous views first, so two Lenses can never merge into
		 * one unqualified namespace and a stale `notes` can never outlive the
		 * interpretation that defined it.
		 */
		selectLens(lens: Lens): Result<void, InspectionError> {
			return trySync({
				try: () => {
					requireOpen();
					dropFriendlyViews();
					const namespace = quoteLiteral(lens.namespace);
					try {
						for (const [tableName, definition] of Object.entries(lens.tables)) {
							const columns = [
								'f.row_id AS "id"',
								...Object.keys(definition.fields).map(fieldColumnSql),
							];
							database.run(
								`CREATE TEMP VIEW ${quoteIdentifier(tableName)} AS
									SELECT ${columns.join(', ')}
									FROM main._replica_v1_visible_rows AS f
									WHERE f.namespace = ${namespace}
										AND f.table_name = ${quoteLiteral(tableName)}
										AND f.presence = 'present'`,
							);
							mounted.push(tableName);
						}
					} catch (cause) {
						// A half-mounted interpretation is worse than none: some tables
						// would answer and others would not, with nothing saying why.
						dropFriendlyViews();
						throw cause;
					}
					selected = lens.namespace;
					return undefined;
				},
				catch: (cause) => InspectionError.QueryFailed({ cause }),
			});
		},

		/** Drop the friendly views, leaving the raw relations available. */
		clearLens(): Result<void, InspectionError> {
			return trySync({
				try: () => {
					requireOpen();
					dropFriendlyViews();
					return undefined;
				},
				catch: (cause) => InspectionError.QueryFailed({ cause }),
			});
		},

		/** The namespace of the currently selected Lens, if any. */
		get selectedNamespace(): string | undefined {
			return selected;
		},

		/** The table names currently mounted as friendly views. */
		get mountedTables(): readonly string[] {
			return [...mounted];
		},

		/**
		 * Run one read-only statement and return bounded rows.
		 *
		 * `prepare` compiles exactly one statement and ignores anything after it,
		 * which `inspection.test.ts` pins against the real engine: a trailing
		 * `INSERT` is never executed. The read-only connection refuses it anyway,
		 * so a submitted write fails on two independent grounds.
		 *
		 * The statement is stepped rather than drained, so the bounds stop the work
		 * instead of trimming its result.
		 */
		query(sql: string): Result<InspectionResult, InspectionError> {
			return trySync({
				try: () => {
					requireOpen();
					const statement = database.prepare<InspectionRow, []>(sql);
					try {
						return readBounded(statement.iterate(), bounds);
					} finally {
						statement.finalize();
					}
				},
				catch: (cause) =>
					isClosed
						? InspectionError.Closed()
						: InspectionError.QueryFailed({ cause }),
			});
		},

		close(): void {
			if (isClosed) return;
			isClosed = true;
			// TEMP views die with the connection, so there is nothing to unwind.
			database.close();
		},
	};
}

export type Inspection = ReturnType<typeof createInspection>;
