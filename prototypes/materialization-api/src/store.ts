/**
 * The physical store mechanics both prototypes share: pragmas, table creation,
 * the monotonic write door, and reads.
 *
 * These are deliberately common so the tests compare API *shape* rather than
 * SQL quality. Everything the two prototypes disagree about (what is stored as
 * the rebuild gate, who may drop, who names the path) lives in their own files.
 */

import { Database } from 'bun:sqlite';
import type { UpstreamRecord } from './authority.ts';
import type { Json, MaterializationDeclaration } from './declaration.ts';

/** A SQL identifier we minted ourselves; rejects anything a provider could inject. */
export function sqlIdent(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new TypeError(
			`Refusing to use ${JSON.stringify(name)} as a SQL identifier`,
		);
	}
	return name;
}

/**
 * ADR-0192 clause B, minus the parts that are the caller's to decide. A
 * read-only connection gets a busy timeout and nothing else: SQLite itself
 * rejects every write, so a reader cannot migrate, drop, or stamp even if its
 * API offered the method.
 */
export function openConnection(
	path: string,
	{ readonly }: { readonly: boolean },
): Database {
	const db = new Database(
		path,
		readonly ? { readonly: true } : { create: true },
	);
	db.exec('PRAGMA busy_timeout = 5000;');
	if (!readonly) {
		db.exec('PRAGMA journal_mode = WAL;');
		db.exec('PRAGMA synchronous = NORMAL;');
	}
	return db;
}

export function listDerivedTables(
	db: Database,
	reserved: readonly string[],
): string[] {
	const reservedSet = new Set(reserved);
	return db
		.query<{ name: string }, []>(
			`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
		)
		.all()
		.map((row) => row.name)
		.filter((name) => !reservedSet.has(name));
}

export function dropTables(db: Database, names: readonly string[]): void {
	for (const name of names) db.exec(`DROP TABLE IF EXISTS ${sqlIdent(name)};`);
}

export function createTable(
	db: Database,
	declaration: MaterializationDeclaration,
	name: string,
): void {
	const table = declaration.tables[name];
	if (!table) throw new TypeError(`No table declared for ${name}`);
	const projected = table.columns
		.map((column) => `,\n\t\t\t${sqlIdent(column.name)} ${column.type}`)
		.join('');
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${sqlIdent(table.table)} (
			id          TEXT PRIMARY KEY,
			raw         TEXT NOT NULL,
			version     INTEGER,
			synced_at   TEXT NOT NULL,
			deleted     INTEGER NOT NULL DEFAULT 0${projected}
		);
	`);
}

export function createDeclaredTables(
	db: Database,
	declaration: MaterializationDeclaration,
): void {
	for (const name of Object.keys(declaration.tables))
		createTable(db, declaration, name);
}

/** Idempotent, and never a rebuild input: an index holds no facts (ADR-0194). */
export function applyIndexes(
	db: Database,
	declaration: MaterializationDeclaration,
): void {
	for (const [name, columns] of Object.entries(declaration.indexes ?? {})) {
		const [tableName, ...rest] = name.split('.');
		const table =
			tableName === undefined ? undefined : declaration.tables[tableName];
		if (!table || rest.length !== 1) continue;
		db.exec(
			`CREATE INDEX IF NOT EXISTS ${sqlIdent(`idx_${table.table}_${rest[0]}`)}
			 ON ${sqlIdent(table.table)}(${columns.map(sqlIdent).join(', ')});`,
		);
	}
}

function project(record: UpstreamRecord, path: string[]): Json | null {
	let cursor: Json = record.data as Json;
	for (const segment of path) {
		if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor))
			return null;
		cursor = (cursor as { [key: string]: Json })[segment] ?? null;
	}
	return cursor;
}

export type MirrorRow = {
	id: string;
	raw: string;
	version: number | null;
	synced_at: string;
	deleted: number;
	[column: string]: unknown;
};

/**
 * One write door, monotonic on the upstream's per-record version, degrading
 * explicitly to last-writer-wins when the upstream supplies none (ADR-0192
 * clause B, generalizing ADR-0063). Both prototypes route every write here, so
 * neither can drift from the other on the invariant the contract exists for.
 */
export function ingest(
	db: Database,
	declaration: MaterializationDeclaration,
	records: readonly UpstreamRecord[],
	{ syncedAt }: { syncedAt: string },
): void {
	const write = db.transaction(() => {
		for (const record of records) {
			const table = declaration.tables[record.table];
			if (!table) continue;
			const columns = table.columns;
			const names = [
				'id',
				'raw',
				'version',
				'synced_at',
				'deleted',
				...columns.map((c) => c.name),
			];
			const values: unknown[] = [
				record.id,
				JSON.stringify(record.data),
				record.version,
				syncedAt,
				record.deleted ? 1 : 0,
				...columns.map((column) => {
					const value = project(record, column.path);
					return value === null || typeof value === 'object' ? null : value;
				}),
			];
			const quoted = sqlIdent(table.table);
			db.query(
				`INSERT INTO ${quoted} (${names.map(sqlIdent).join(', ')})
				 VALUES (${names.map(() => '?').join(', ')})
				 ON CONFLICT(id) DO UPDATE SET
				   ${names
							.filter((n) => n !== 'id')
							.map((n) => `${sqlIdent(n)} = excluded.${sqlIdent(n)}`)
							.join(', ')}
				 WHERE excluded.version IS NULL
				    OR ${quoted}.version IS NULL
				    OR excluded.version >= ${quoted}.version`,
			).run(...(values as never[]));
		}
	});
	write.immediate();
}

export function readTable(
	db: Database,
	declaration: MaterializationDeclaration,
	name: string,
): MirrorRow[] {
	const table = declaration.tables[name];
	if (!table) throw new TypeError(`No table declared for ${name}`);
	return db
		.query<MirrorRow, []>(`SELECT * FROM ${sqlIdent(table.table)} ORDER BY id`)
		.all();
}
