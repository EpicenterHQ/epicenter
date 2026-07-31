/**
 * The inert half of the mirror API.
 *
 * A declaration is plain data describing the stored shape of an
 * external-authority mirror: which tables exist, which columns are projected
 * out of the authority's own record, and which are computed by the app before
 * the write. It holds no authority identity, no credentials, no paths, no
 * cursors, and no runtime resources; `defineMirror` performs no I/O and reads
 * no environment. Two processes that import the same declaration get the same
 * `canonical` string, which is the whole point: that string is the rebuild
 * gate.
 *
 * Every mirror table carries the same three invariant columns, because every
 * mirror row is the same thing (one regenerable record from an external
 * authority, and when we last saw it):
 *
 *   id        TEXT PRIMARY KEY   the authority's own id
 *   raw       TEXT NOT NULL      the verbatim authority record, as JSON
 *   synced_at TEXT NOT NULL      the pass that last touched this row
 *
 * Everything else is declared.
 */

import { canonicalJson } from './canonical.ts';

export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';

/**
 * A column SQLite projects out of `raw` with `json_extract`. `from` is the
 * path into the authority record, so `['CustomerRef', 'value']` reads
 * `$.CustomerRef.value`. Projections are the default kind of column: the blob
 * stays the single source of truth, a missing field is null for free, and
 * there is no write path to keep in sync.
 *
 * `stored: true` materializes the value on disk instead of computing it per
 * read. Sorting and indexing want STORED; everything else wants the default.
 * It changes the on-disk shape, so it is a rebuild input.
 */
export type ProjectedColumn = {
	type: ColumnType;
	from: readonly string[];
	stored?: true;
};

/**
 * A column the app computes in TypeScript and hands to `upsert`, for values
 * SQLite cannot express: a MIME walk over a multipart body, a header lookup
 * inside `payload.headers[]`, a decode. It exists only because a query needs
 * the value on disk; if nothing indexes or searches it, derive it at read time
 * from `raw` instead and declare nothing.
 *
 * `revision` is an opaque author token for the code that computes the value.
 * Bump it when that code starts producing different output for the same input.
 * This is the one hand-stamped input in the whole system, and it is
 * unavoidable: the value's shape lives in a function, and hashing function
 * source would make reformatting a rebuild.
 */
export type SuppliedColumn = {
	type: ColumnType;
	revision: string;
};

/**
 * Declares that this table's rows carry an authority-assigned ordering value,
 * extracted from `from` and stored in `column`. Its presence is what makes
 * writes monotonic: a row only ever moves forward, so a stale write (a
 * write-through fold landing after a newer sync already ingested the record)
 * cannot regress the mirror. A table with no authority ordering value omits
 * this and gets last-writer-wins, which is the honest behavior when there is
 * nothing to order on.
 */
export type OrderBy = {
	column: string;
	from: readonly string[];
};

export type TableDeclaration = {
	columns?: Record<string, ProjectedColumn>;
	supplied?: Record<string, SuppliedColumn>;
	orderBy?: OrderBy;
	/**
	 * Adds `deleted INTEGER NOT NULL DEFAULT 0` and the `softDelete` verb. Pick
	 * this when the authority tells you a record is gone but the mirror is the
	 * only surviving copy of what it was; pick physical `remove` when the
	 * authority's own delete means the bytes should go too.
	 */
	softDelete?: true;
	/**
	 * Indexes, as column lists. Deliberately not a rebuild input: an index
	 * holds no mirror facts, so changing a query optimization must never force a
	 * re-pull. Writers apply these idempotently on every table create; readers
	 * never touch them.
	 */
	indexes?: Record<string, readonly string[]>;
};

export type MirrorDeclaration = {
	/**
	 * Namespaces this declaration so two unrelated mirrors that happen to share
	 * a shape do not share an identity. It names the declaration, never the
	 * authority instance: `epicenter.local-books.mirror`, never a realm id.
	 */
	domain: string;
	tables: Record<string, TableDeclaration>;
};

export type Mirror = {
	readonly domain: string;
	readonly tables: Readonly<Record<string, TableDeclaration>>;
	/**
	 * The rebuild gate: a deterministic serialization of everything about this
	 * declaration that changes the stored shape. Compared for equality, never
	 * parsed. Stored verbatim so a stale mirror can be diffed against the
	 * current declaration and say which column moved, instead of reporting that
	 * two hashes differ.
	 */
	readonly canonical: string;
};

/** The serialization format tag, prefixed so the format itself can change. */
const FORMAT = 'epicenter.mirror/1';

/** Identifiers this API mints into DDL: lowercase snake case, nothing to quote. */
const SQL_IDENT = /^[a-z_][a-z0-9_]*$/;

/** One field name inside an authority record. Authority fields are mixed case. */
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The invariant columns, which no declaration may shadow. `deleted` joins them
 * when a table declares `softDelete`.
 */
const RESERVED_COLUMNS = new Set(['id', 'raw', 'synced_at', 'deleted']);

function assertIdent(kind: string, name: string): string {
	if (!SQL_IDENT.test(name)) {
		throw new Error(`Unsafe ${kind} in mirror declaration: ${name}`);
	}
	return name;
}

/**
 * The one identifier gate. Declaration names pass through it when the mirror is
 * defined, so the writer interpolates declared names into DDL and DML without
 * re-checking; the handles reuse it for the table name a caller passes to
 * `exists`/`count`, which is the only identifier that does not come from a
 * declaration.
 */
export function sqlIdent(name: string): string {
	return assertIdent('identifier', name);
}

function assertPath(path: readonly string[]): readonly string[] {
	if (path.length === 0) {
		throw new Error('A mirror column path cannot be empty');
	}
	for (const segment of path) {
		if (!PATH_SEGMENT.test(segment)) {
			throw new Error(`Unsafe path segment in mirror declaration: ${segment}`);
		}
	}
	return path;
}

function assertColumnName(table: string, name: string): string {
	if (RESERVED_COLUMNS.has(name)) {
		throw new Error(
			`Table "${table}" cannot declare "${name}": every mirror table already has it`,
		);
	}
	return assertIdent('column name', name);
}

/**
 * The rebuild-relevant projection of a declaration, and the only thing that
 * reaches the canonical string.
 *
 * Indexes are excluded structurally: nothing here reads `indexes`, so there is
 * no list of exclusions to keep current and no way to add an index field that
 * accidentally becomes a rebuild input. Optional fields are normalized to
 * explicit `false`/`null` so that "absent" and "declared falsy" serialize the
 * same way.
 */
function rebuildShape(declaration: MirrorDeclaration): unknown {
	const tables: Record<string, unknown> = {};
	for (const [table, definition] of Object.entries(declaration.tables)) {
		assertIdent('table name', table);

		const columns: Record<string, unknown> = {};
		for (const [name, column] of Object.entries(definition.columns ?? {})) {
			assertColumnName(table, name);
			columns[name] = {
				type: column.type,
				from: [...assertPath(column.from)],
				stored: column.stored === true,
			};
		}

		const supplied: Record<string, unknown> = {};
		for (const [name, column] of Object.entries(definition.supplied ?? {})) {
			assertColumnName(table, name);
			if (name in columns) {
				throw new Error(
					`Table "${table}" declares "${name}" as both projected and supplied`,
				);
			}
			supplied[name] = { type: column.type, revision: column.revision };
		}

		const orderBy = definition.orderBy;
		if (orderBy) assertColumnName(table, orderBy.column);

		for (const [name, indexColumns] of Object.entries(
			definition.indexes ?? {},
		)) {
			assertIdent('index name', name);
			if (indexColumns.length === 0) {
				throw new Error(`Index "${name}" on "${table}" names no columns`);
			}
			for (const indexColumn of indexColumns) {
				assertIdent('index column', indexColumn);
			}
		}

		tables[table] = {
			columns,
			supplied,
			orderBy: orderBy
				? { column: orderBy.column, from: [...assertPath(orderBy.from)] }
				: null,
			softDelete: definition.softDelete === true,
		};
	}

	return { domain: declaration.domain, tables };
}

/**
 * Freeze a declaration into a mirror. Pure: no filesystem, no database, no
 * clock, no environment. The returned value is safe to build at module scope
 * and share between a writer process and a reader process.
 */
export function defineMirror(declaration: MirrorDeclaration): Mirror {
	if (declaration.domain.length === 0) {
		throw new Error('A mirror declaration needs a domain');
	}
	const canonical = `${FORMAT} ${canonicalJson(rebuildShape(declaration))}`;
	return {
		domain: declaration.domain,
		tables: declaration.tables,
		canonical,
	};
}

// ── DDL, derived from the declaration and nothing else ──

function jsonPath(path: readonly string[]): string {
	return `$.${path.join('.')}`;
}

/** Every column of one mirror table, in a stable order. */
export function createTableSql(
	table: string,
	definition: TableDeclaration,
): string {
	const lines = [
		'id TEXT PRIMARY KEY',
		'raw TEXT NOT NULL',
		'synced_at TEXT NOT NULL',
	];
	if (definition.orderBy) lines.push(`${definition.orderBy.column} TEXT`);
	if (definition.softDelete) lines.push('deleted INTEGER NOT NULL DEFAULT 0');
	for (const [name, column] of Object.entries(definition.columns ?? {})) {
		lines.push(
			`${name} ${column.type} GENERATED ALWAYS AS (json_extract(raw, '${jsonPath(column.from)}')) ${column.stored ? 'STORED' : 'VIRTUAL'}`,
		);
	}
	for (const [name, column] of Object.entries(definition.supplied ?? {})) {
		lines.push(`${name} ${column.type}`);
	}
	return `CREATE TABLE IF NOT EXISTS ${table} (\n\t${lines.join(',\n\t')}\n)`;
}

export function createIndexSql(
	table: string,
	definition: TableDeclaration,
): string[] {
	return Object.entries(definition.indexes ?? {}).map(
		([name, columns]) =>
			`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns.join(', ')})`,
	);
}

/**
 * Read one ordering value out of an authority record. Returns null for a
 * missing or non-scalar value, which the monotonic guard reads as "nothing to
 * order on".
 */
export function readPath(
	record: Record<string, unknown>,
	path: readonly string[],
): string | null {
	let cursor: unknown = record;
	for (const segment of path) {
		if (typeof cursor !== 'object' || cursor === null) return null;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	if (typeof cursor === 'string') return cursor;
	if (typeof cursor === 'number') return String(cursor);
	return null;
}
