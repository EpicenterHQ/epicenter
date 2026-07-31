/**
 * Declaration to SQL. Pure: a host can print a mirror's schema for an agent
 * tool, a review, or a diff without a database existing anywhere.
 */

import type {
	ColumnType,
	DerivedTable,
	MirrorDeclaration,
	Retention,
	SourceTable,
	TableMap,
} from './declare.ts';

export const RAW_COLUMN = '_raw';

export function retentionOf(decl: SourceTable<never>): Retention {
	return decl.retain ?? 'raw';
}

/** The one metadata relation. Fingerprint, cursor, and per-table backfill
 * latches all live here, so a rebuild is `DROP` plus one `DELETE`. */
export const META_TABLE = '_mirror';

export const META_KEYS = {
	fingerprint: 'fingerprint',
	cursor: 'cursor',
	syncedAt: 'synced_at',
	backfilled: (table: string) => `backfilled:${table}`,
} as const;

const STORAGE: Record<ColumnType, string> = {
	text: 'TEXT',
	integer: 'INTEGER',
	real: 'REAL',
	json: 'TEXT',
};

export function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

export function indexName(table: string, columns: readonly string[]): string {
	return `_mirror_idx_${table}__${columns.join('_')}`;
}

function derivedColumnType(
	column: DerivedTable['columns'][string],
): ColumnType {
	return typeof column === 'string' ? column : column.type;
}

/**
 * Every payload column is SQL-nullable. A tombstone keeps its key and version
 * but has no payload, so a `NOT NULL` payload column would make the terminal
 * state unrepresentable. Non-nullability is enforced at ingest instead.
 */
function createSourceTable(tableKey: string, decl: SourceTable<never>): string {
	const columns = [
		`${quote('_key')} TEXT PRIMARY KEY NOT NULL`,
		`${quote('_version')} ${decl.version.order === 'numeric' ? 'REAL' : 'TEXT'} NOT NULL`,
		`${quote('_deleted')} INTEGER NOT NULL DEFAULT 0`,
		`${quote('_synced_at')} INTEGER NOT NULL`,
		// Nullable because a tombstone has no authority object to keep.
		...(retentionOf(decl) === 'raw' ? [`${quote('_raw')} TEXT`] : []),
		...Object.entries(decl.columns).map(
			([column, columnDecl]) => `${quote(column)} ${STORAGE[columnDecl.type]}`,
		),
	];
	return `CREATE TABLE IF NOT EXISTS ${quote(tableKey)} (\n  ${columns.join(',\n  ')}\n) STRICT`;
}

/**
 * A derived row is owned by one source row. `_source` is half the primary key,
 * which is what makes "replace the whole derived set for this source" a single
 * indexed delete.
 */
function createDerivedTable(tableKey: string, decl: DerivedTable): string {
	const columns = [
		`${quote('_source')} TEXT NOT NULL`,
		...Object.entries(decl.columns).map(
			([column, columnDecl]) =>
				`${quote(column)} ${STORAGE[derivedColumnType(columnDecl)]}`,
		),
		`PRIMARY KEY (${quote('_source')}, ${quote(decl.key)})`,
	];
	return `CREATE TABLE IF NOT EXISTS ${quote(tableKey)} (\n  ${columns.join(',\n  ')}\n) STRICT`;
}

export function createMetaTable(): string {
	return `CREATE TABLE IF NOT EXISTS ${quote(META_TABLE)} (\n  ${quote('key')} TEXT PRIMARY KEY NOT NULL,\n  ${quote('value')} TEXT\n) STRICT`;
}

export function tableStatements(
	declaration: MirrorDeclaration<TableMap>,
): string[] {
	return Object.entries(declaration.tables).map(([tableKey, decl]) =>
		decl.kind === 'source'
			? createSourceTable(tableKey, decl)
			: createDerivedTable(tableKey, decl),
	);
}

/** Declared indexes, including the implicit `_source` index every derived table
 * needs for owner-scoped replacement. Never fingerprinted. */
export function indexStatements(
	declaration: MirrorDeclaration<TableMap>,
): { name: string; sql: string }[] {
	const statements: { name: string; sql: string }[] = [];
	for (const [tableKey, decl] of Object.entries(declaration.tables)) {
		for (const columns of decl.indexes ?? []) {
			const name = indexName(tableKey, columns);
			statements.push({
				name,
				sql: `CREATE INDEX IF NOT EXISTS ${quote(name)} ON ${quote(tableKey)} (${columns.map(quote).join(', ')})`,
			});
		}
	}
	return statements;
}

/**
 * The full schema as text. Useful to a host that wants to show an agent what it
 * may query, and to a reviewer diffing two declarations.
 */
export function describeMirror(
	declaration: MirrorDeclaration<TableMap>,
): string {
	return [
		`-- mirror: ${declaration.name}`,
		`-- fingerprint: ${declaration.fingerprint}`,
		createMetaTable(),
		...tableStatements(declaration),
		...indexStatements(declaration).map((index) => index.sql),
	].join(';\n\n');
}
