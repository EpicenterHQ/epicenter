/**
 * Opening layer: binding a declaration to a file, with an intent.
 *
 * There are two entry points, not one with a mode flag, because a reader and a
 * writer are not the same operation with a permission difference. A writer owns
 * the rebuild gate and the write door. A reader owns neither and cannot be
 * handed either by accident: when the on-disk shape does not match, it is
 * returned a status with *no query surface at all*, so reading a mismatched
 * shape is unrepresentable rather than merely discouraged.
 */

import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type {
	DerivedTable,
	Extractor,
	MirrorDeclaration,
	ObjectOf,
	SourceKeys,
	SourceTable,
	TableMap,
} from './declare.ts';
import { isPathRef } from './declare.ts';
import {
	createMetaTable,
	indexName,
	indexStatements,
	META_KEYS,
	META_TABLE,
	quote,
	RAW_COLUMN,
	retentionOf,
	tableStatements,
} from './schema.ts';

// --- errors -----------------------------------------------------------------

/**
 * Another writer rebuilt this file under a different declaration while we held
 * it open. Thrown inside the transaction, so the offending write never lands.
 */
export class MirrorSupersededError extends Error {
	override readonly name = 'MirrorSupersededError';
	constructor(
		readonly expected: string,
		readonly found: string | null,
	) {
		super(
			`mirror was rebuilt under a different declaration (expected ${expected}, found ${found ?? 'none'})`,
		);
	}
}

/** A projection produced a value the declared column cannot hold. Loud, because
 * a silently coerced column is a mirror that lies. */
export class MirrorProjectionError extends Error {
	override readonly name = 'MirrorProjectionError';
}

// --- connection contract ----------------------------------------------------

/**
 * One concurrency contract for every connection (ADR-0063). WAL so readers never
 * block the writer, a busy timeout so a contended writer waits instead of
 * failing instantly, and `synchronous = NORMAL` because a lost last commit on a
 * re-pullable cache costs a re-pull, never the ledger.
 */
const BUSY_TIMEOUT_MS = 5_000;

function connectForWriting(path: string): Database {
	const database = new Database(path, { create: true, strict: true });
	database.run('PRAGMA journal_mode = WAL');
	database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	database.run('PRAGMA synchronous = NORMAL');
	return database;
}

function connectForReading(path: string): Database {
	const database = new Database(path, { readonly: true, strict: true });
	database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	return database;
}

// --- extraction -------------------------------------------------------------

function extract(
	extractor: Extractor<never, unknown>,
	object: unknown,
): unknown {
	if (typeof extractor === 'function') {
		return (extractor as (object: unknown) => unknown)(object);
	}
	if (!isPathRef(extractor)) {
		throw new MirrorProjectionError(
			'an extractor must be a path() or function',
		);
	}
	let cursor: unknown = object;
	for (const segment of extractor.$path) {
		if (cursor === null || cursor === undefined) return undefined;
		if (typeof cursor !== 'object') return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

function coerce(
	value: unknown,
	type: 'text' | 'integer' | 'real' | 'json',
	where: string,
): string | number | null {
	if (value === null || value === undefined) return null;
	if (type === 'json') return JSON.stringify(value);
	if (type === 'text') {
		if (typeof value !== 'string') {
			throw new MirrorProjectionError(
				`${where}: declared text, projected ${typeof value}`,
			);
		}
		return value;
	}
	if (typeof value === 'boolean') {
		if (type !== 'integer') {
			throw new MirrorProjectionError(
				`${where}: declared real, projected boolean`,
			);
		}
		return value ? 1 : 0;
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new MirrorProjectionError(
			`${where}: declared ${type}, projected ${typeof value}`,
		);
	}
	return type === 'integer' ? Math.trunc(value) : value;
}

function requireKey(value: unknown, tableKey: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new MirrorProjectionError(
			`${tableKey}: key projected ${JSON.stringify(value)}, expected a non-empty string`,
		);
	}
	return value;
}

/**
 * The version is mandatory. An authority that hands out no per-object version
 * cannot back a monotonic mirror, and discovering that at ingest time (as a
 * last-writer-wins fallback) hides the problem instead of naming it.
 */
function requireVersion(
	value: unknown,
	order: 'lexical' | 'numeric',
	tableKey: string,
): string | number {
	if (order === 'numeric') {
		const numeric = typeof value === 'string' ? Number(value) : value;
		if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
			throw new MirrorProjectionError(
				`${tableKey}: numeric version projected ${JSON.stringify(value)}`,
			);
		}
		return numeric;
	}
	if (typeof value !== 'string' || value.length === 0) {
		throw new MirrorProjectionError(
			`${tableKey}: lexical version projected ${JSON.stringify(value)}`,
		);
	}
	return value;
}

// --- shared metadata access -------------------------------------------------

function readMeta(database: Database, key: string): string | null {
	const row = database
		.query<{ value: string | null }, [string]>(
			`SELECT value FROM ${quote(META_TABLE)} WHERE key = ?`,
		)
		.get(key);
	return row?.value ?? null;
}

function hasMetaTable(database: Database): boolean {
	return (
		database
			.query<{ name: string }, [string]>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
			)
			.get(META_TABLE) !== null
	);
}

// --- writer -----------------------------------------------------------------

export type IngestBatches<TTables extends TableMap> = {
	readonly [S in SourceKeys<TTables>]?: readonly ObjectOf<TTables[S]>[];
};

export type IngestOptions<TTables extends TableMap> = {
	/**
	 * Advance the one mirror-wide cursor in the same transaction as the rows it
	 * accounts for (ADR-0064). Omit it and the cursor does not move, which is
	 * what a targeted repair or a write-back fold wants.
	 */
	readonly cursor?: string;
	/**
	 * Tables this batch fully pulled. Sets the backfill latch. Absence from a
	 * full pull never means deletion; only an explicit authority tombstone does.
	 */
	readonly full?: readonly SourceKeys<TTables>[];
};

export type IngestReport = {
	readonly applied: number;
	readonly rejectedStale: number;
	readonly tombstoned: number;
};

export type MirrorWriter<TTables extends TableMap> = {
	/**
	 * True when this open rebuilt the mirror. It does *not* mean the data is
	 * gone: a `retain: 'raw'` table is reprojected from the authority objects it
	 * already holds, keeping its rows, its cursor, and its backfill latch.
	 *
	 * The host's actual full-pull signal is `needsBackfill`, which is empty when
	 * the whole rebuild was local.
	 */
	readonly rebuilt: boolean;
	readonly cursor: string | null;
	readonly syncedAt: number | null;
	/** Source tables that have never had a full pull recorded. */
	readonly needsBackfill: readonly SourceKeys<TTables>[];
	readonly ingest: (
		batches: IngestBatches<TTables>,
		options?: IngestOptions<TTables>,
	) => IngestReport;
	readonly close: () => void;
	readonly [Symbol.dispose]: () => void;
};

export type OpenWriterOptions = {
	readonly path: string;
	/**
	 * Force a rebuild even when the fingerprint matches. The escape hatch for a
	 * projection whose *meaning* changed while its *shape* did not, which is the
	 * one thing the fingerprint gate cannot see. On a `retain: 'raw'` mirror this
	 * is a local recompute and costs nothing but CPU.
	 *
	 * Deliberately an open option and not a `writer.rebuild()` method: a writer's
	 * prepared statements and shape assumption are fixed for its whole life.
	 */
	readonly rebuild?: boolean;
};

type SourceRuntime = {
	readonly tableKey: string;
	readonly decl: SourceTable<never>;
	readonly retainsRaw: boolean;
	readonly upsert: Statement;
	readonly tombstone: Statement;
	readonly derivedTables: readonly {
		readonly tableKey: string;
		readonly decl: DerivedTable;
		readonly insert: Statement;
		readonly clear: Statement;
	}[];
};

export function openMirrorWriter<TTables extends TableMap>(
	declaration: MirrorDeclaration<TTables>,
	options: OpenWriterOptions,
): MirrorWriter<TTables> {
	const database = connectForWriting(options.path);
	let rebuilt = false;
	let sources = new Map<string, SourceRuntime>();

	// One transaction covers the whole open, including reprojection, so the
	// fingerprint is stamped only once the new shape is genuinely populated. A
	// crash mid-rebuild leaves the previous mirror, never a half-built one whose
	// stamp claims it is current.
	database
		.transaction(() => {
			database.run(createMetaTable());
			const stored = readMeta(database, META_KEYS.fingerprint);
			const mustRebuild =
				options.rebuild === true || stored !== declaration.fingerprint;

			if (!mustRebuild) {
				for (const statement of tableStatements(declaration))
					database.run(statement);
				reconcileIndexes(database, declaration);
				sources = prepareSources(database, declaration);
				return;
			}

			rebuilt = true;
			const carried = carryOverMeta(database, declaration);
			const salvaged = setAsideReprojectable(database, declaration);
			dropEverything(
				database,
				salvaged.map((entry) => entry.holdingTable),
			);
			database.run(createMetaTable());
			for (const statement of tableStatements(declaration))
				database.run(statement);
			reconcileIndexes(database, declaration);
			sources = prepareSources(database, declaration);

			const reprojected = new Set<string>();
			for (const entry of salvaged) {
				if (reproject(database, sources, declaration, entry)) {
					reprojected.add(entry.tableKey);
				}
				database.run(`DROP TABLE IF EXISTS ${quote(entry.holdingTable)}`);
			}
			// A table that could not be reprojected loses its latch and will be
			// backfilled; the realm cursor survives, exactly as it does when a brand
			// new table joins the declaration (ADR-0064).
			restoreMeta(database, declaration, carried, reprojected);
		})
		.immediate();

	const setMeta = database.prepare(
		`INSERT INTO ${quote(META_TABLE)} (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);

	const assertNotSuperseded = () => {
		const found = readMeta(database, META_KEYS.fingerprint);
		if (found !== declaration.fingerprint) {
			throw new MirrorSupersededError(declaration.fingerprint, found);
		}
	};

	const ingest = database.transaction(
		(
			batches: Record<string, readonly unknown[] | undefined>,
			ingestOptions: IngestOptions<TTables>,
		): IngestReport => {
			assertNotSuperseded();
			const syncedAt = Date.now();
			let applied = 0;
			let rejectedStale = 0;
			let tombstoned = 0;

			for (const [tableKey, objects] of Object.entries(batches)) {
				if (objects === undefined) continue;
				const source = sources.get(tableKey);
				if (source === undefined) {
					throw new MirrorProjectionError(`unknown source table "${tableKey}"`);
				}
				for (const object of objects) {
					const outcome = writeOne(source, object, syncedAt, declaration);
					if (outcome === 'stale') {
						rejectedStale += 1;
						continue;
					}
					applied += 1;
					if (outcome === 'tombstoned') tombstoned += 1;
				}
			}

			if (ingestOptions.cursor !== undefined) {
				setMeta.run(META_KEYS.cursor, ingestOptions.cursor);
			}
			for (const tableKey of ingestOptions.full ?? []) {
				setMeta.run(META_KEYS.backfilled(tableKey), String(syncedAt));
			}
			setMeta.run(META_KEYS.syncedAt, String(syncedAt));
			return { applied, rejectedStale, tombstoned };
		},
	);

	const close = () => database.close(false);

	return {
		rebuilt,
		get cursor() {
			return readMeta(database, META_KEYS.cursor);
		},
		get syncedAt() {
			const value = readMeta(database, META_KEYS.syncedAt);
			return value === null ? null : Number(value);
		},
		get needsBackfill() {
			return sourceKeys(declaration).filter(
				(tableKey) =>
					readMeta(database, META_KEYS.backfilled(tableKey)) === null,
			) as unknown as readonly SourceKeys<TTables>[];
		},
		ingest: (batches, ingestOptions) =>
			ingest.immediate(
				batches as Record<string, readonly unknown[] | undefined>,
				ingestOptions ?? {},
			),
		close,
		[Symbol.dispose]: close,
	};
}

/**
 * A mirror owns its file exclusively, so a rebuild drops every relation rather
 * than only the ones the *current* declaration names. Dropping only the current
 * set would strand a table that the previous declaration created and this one
 * removed, and that orphan is invisible to every later fingerprint check.
 */
function dropEverything(database: Database, keep: readonly string[]): void {
	const kept = new Set(keep);
	const tables = database
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
		)
		.all();
	for (const { name } of tables) {
		if (kept.has(name)) continue;
		database.run(`DROP TABLE IF EXISTS ${quote(name)}`);
	}
}

// --- local reprojection -----------------------------------------------------

const HOLDING_PREFIX = '_reproject_';

type Salvaged = { readonly tableKey: string; readonly holdingTable: string };

type CarriedMeta = {
	readonly cursor: string | null;
	readonly syncedAt: string | null;
	readonly latched: readonly string[];
};

function carryOverMeta(
	database: Database,
	declaration: MirrorDeclaration<TableMap>,
): CarriedMeta {
	return {
		cursor: readMeta(database, META_KEYS.cursor),
		syncedAt: readMeta(database, META_KEYS.syncedAt),
		latched: sourceKeys(declaration).filter(
			(tableKey) => readMeta(database, META_KEYS.backfilled(tableKey)) !== null,
		),
	};
}

function restoreMeta(
	database: Database,
	declaration: MirrorDeclaration<TableMap>,
	carried: CarriedMeta,
	reprojected: ReadonlySet<string>,
): void {
	const set = (key: string, value: string) =>
		database.run(
			`INSERT INTO ${quote(META_TABLE)} (key, value) VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			[key, value],
		);
	set(META_KEYS.fingerprint, declaration.fingerprint);
	if (reprojected.size === 0) return;
	if (carried.cursor !== null) set(META_KEYS.cursor, carried.cursor);
	if (carried.syncedAt !== null) set(META_KEYS.syncedAt, carried.syncedAt);
	for (const tableKey of carried.latched) {
		if (reprojected.has(tableKey)) {
			set(META_KEYS.backfilled(tableKey), carried.syncedAt ?? '0');
		}
	}
}

function hasColumn(database: Database, table: string, column: string): boolean {
	return database
		.query<{ name: string }, []>(`PRAGMA table_info(${quote(table)})`)
		.all()
		.some((row) => row.name === column);
}

/**
 * Rename aside every table the new declaration could rebuild from what is
 * already on disk: a source table it still names, retaining raw, whose existing
 * table kept a `_raw` column. Everything else is dropped and re-pulled.
 */
function setAsideReprojectable(
	database: Database,
	declaration: MirrorDeclaration<TableMap>,
): Salvaged[] {
	const existing = new Set(
		database
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table'",
			)
			.all()
			.map((row) => row.name),
	);
	const salvaged: Salvaged[] = [];
	for (const [tableKey, decl] of Object.entries(declaration.tables)) {
		if (decl.kind !== 'source') continue;
		if (retentionOf(decl as SourceTable<never>) !== 'raw') continue;
		if (!existing.has(tableKey)) continue;
		if (!hasColumn(database, tableKey, RAW_COLUMN)) continue;
		const holdingTable = `${HOLDING_PREFIX}${tableKey}`;
		database.run(`DROP TABLE IF EXISTS ${quote(holdingTable)}`);
		database.run(
			`ALTER TABLE ${quote(tableKey)} RENAME TO ${quote(holdingTable)}`,
		);
		// Indexes follow their table through a rename and keep their names, so the
		// mirror's own index names would still be taken. `CREATE INDEX IF NOT
		// EXISTS` would then no-op, and the index would disappear with the holding
		// table, leaving the rebuilt table silently unindexed.
		for (const index of database
			.query<{ name: string }, [string]>(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE '_mirror_idx_%'",
			)
			.all(holdingTable)) {
			database.run(`DROP INDEX IF EXISTS ${quote(index.name)}`);
		}
		salvaged.push({ tableKey, holdingTable });
	}
	return salvaged;
}

const REPROJECT_BATCH = 500;

type HoldingRow = {
	_key: string;
	_version: string | number;
	_deleted: number;
	_synced_at: number;
	_raw: string | null;
};

/**
 * Rebuild one table's rows from the authority objects it already holds. This is
 * the whole point of `retain: 'raw'`: a declaration change becomes CPU, not a
 * network event, and the cursor and backfill latch survive it.
 */
function reproject(
	database: Database,
	sources: Map<string, SourceRuntime>,
	declaration: MirrorDeclaration<TableMap>,
	entry: Salvaged,
): boolean {
	const source = sources.get(entry.tableKey);
	if (source === undefined) return false;
	const select = database.prepare<HoldingRow, [string, number]>(
		`SELECT ${quote('_key')}, ${quote('_version')}, ${quote('_deleted')}, ${quote('_synced_at')}, ${quote(RAW_COLUMN)}
		 FROM ${quote(entry.holdingTable)}
		 WHERE ${quote('_key')} > ? ORDER BY ${quote('_key')} LIMIT ?`,
	);
	let after = '';
	try {
		for (;;) {
			const rows = select.all(after, REPROJECT_BATCH);
			if (rows.length === 0) break;
			for (const row of rows) {
				if (row._deleted === 1) {
					const version = requireVersion(
						row._version,
						source.decl.version.order,
						entry.tableKey,
					);
					source.tombstone.run(row._key, version, row._synced_at);
					continue;
				}
				if (row._raw === null) {
					throw new MirrorProjectionError(
						`${entry.tableKey}: a live row kept no authority object to reproject`,
					);
				}
				writeOne(source, JSON.parse(row._raw), row._synced_at, declaration);
			}
			after = rows[rows.length - 1]?._key ?? after;
		}
	} catch (error) {
		if (!(error instanceof MirrorProjectionError)) throw error;
		// Degrade to a full re-pull rather than half a table. The same projection
		// failure will surface loudly on the backfill if it was a real bug.
		database.run(`DELETE FROM ${quote(entry.tableKey)}`);
		for (const derived of source.derivedTables) {
			database.run(`DELETE FROM ${quote(derived.tableKey)}`);
		}
		return false;
	}
	return true;
}

/**
 * Indexes are not fingerprint inputs (ADR-0194), so they are reconciled every
 * open instead: create the declared ones, drop mirror-owned ones that no longer
 * appear. Changing a query optimization must never force a re-pull.
 */
function reconcileIndexes(
	database: Database,
	declaration: MirrorDeclaration<TableMap>,
): void {
	const declared = new Set<string>();
	for (const [tableKey, decl] of Object.entries(declaration.tables)) {
		if (decl.kind !== 'derived') continue;
		// Owner-scoped replacement is a mirror invariant, not an optimization the
		// author may withdraw, so this one is implicit.
		const name = indexName(tableKey, ['_source']);
		declared.add(name);
		database.run(
			`CREATE INDEX IF NOT EXISTS ${quote(name)} ON ${quote(tableKey)} (${quote('_source')})`,
		);
	}
	for (const index of indexStatements(declaration)) {
		declared.add(index.name);
		database.run(index.sql);
	}
	const existing = database
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '_mirror_idx_%'",
		)
		.all();
	for (const { name } of existing) {
		if (!declared.has(name))
			database.run(`DROP INDEX IF EXISTS ${quote(name)}`);
	}
}

function sourceKeys(declaration: MirrorDeclaration<TableMap>): string[] {
	return Object.entries(declaration.tables)
		.filter(([, decl]) => decl.kind === 'source')
		.map(([tableKey]) => tableKey);
}

function prepareSources(
	database: Database,
	declaration: MirrorDeclaration<TableMap>,
): Map<string, SourceRuntime> {
	const sources = new Map<string, SourceRuntime>();
	for (const [tableKey, decl] of Object.entries(declaration.tables)) {
		if (decl.kind !== 'source') continue;
		const retainsRaw = retentionOf(decl as SourceTable<never>) === 'raw';
		const columns = Object.keys(decl.columns);
		const nulled = retainsRaw ? [RAW_COLUMN, ...columns] : columns;
		const all = [
			'_key',
			'_version',
			'_deleted',
			'_synced_at',
			...(retainsRaw ? [RAW_COLUMN] : []),
			...columns,
		];
		const assignments = all
			.filter((column) => column !== '_key')
			.map((column) => `${quote(column)} = excluded.${quote(column)}`)
			.join(', ');

		// One monotonic door: the update lands only if the incoming version is at
		// least as new. A stale write is physically unable to regress a row, and
		// `changes === 0` is how the caller learns it happened.
		const upsert = database.prepare(
			`INSERT INTO ${quote(tableKey)} (${all.map(quote).join(', ')})
			 VALUES (${all.map(() => '?').join(', ')})
			 ON CONFLICT(${quote('_key')}) DO UPDATE SET ${assignments}
			 WHERE excluded.${quote('_version')} >= ${quote(tableKey)}.${quote('_version')}`,
		);
		const tombstone = database.prepare(
			`INSERT INTO ${quote(tableKey)} (${quote('_key')}, ${quote('_version')}, ${quote('_deleted')}, ${quote('_synced_at')})
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT(${quote('_key')}) DO UPDATE SET
			   ${quote('_version')} = excluded.${quote('_version')},
			   ${quote('_deleted')} = 1,
			   ${quote('_synced_at')} = excluded.${quote('_synced_at')},
			   ${nulled.map((column) => `${quote(column)} = NULL`).join(', ')}
			 WHERE excluded.${quote('_version')} >= ${quote(tableKey)}.${quote('_version')}`,
		);

		const derivedTables = Object.entries(declaration.tables)
			.filter(
				([, derivedDecl]) =>
					derivedDecl.kind === 'derived' && derivedDecl.of === tableKey,
			)
			.map(([derivedKey, derivedDecl]) => {
				const derived = derivedDecl as DerivedTable;
				const derivedColumns = Object.keys(derived.columns);
				const insertColumns = ['_source', ...derivedColumns];
				return {
					tableKey: derivedKey,
					decl: derived,
					insert: database.prepare(
						`INSERT INTO ${quote(derivedKey)} (${insertColumns.map(quote).join(', ')})
						 VALUES (${insertColumns.map(() => '?').join(', ')})`,
					),
					clear: database.prepare(
						`DELETE FROM ${quote(derivedKey)} WHERE ${quote('_source')} = ?`,
					),
				};
			});

		sources.set(tableKey, {
			tableKey,
			decl: decl as SourceTable<never>,
			retainsRaw,
			upsert,
			tombstone,
			derivedTables,
		});
	}
	return sources;
}

type WriteOutcome = 'applied' | 'tombstoned' | 'stale';

function writeOne(
	source: SourceRuntime,
	object: unknown,
	syncedAt: number,
	declaration: MirrorDeclaration<TableMap>,
): WriteOutcome {
	const { tableKey, decl } = source;
	const key = requireKey(extract(decl.key, object), tableKey);
	const version = requireVersion(
		extract(decl.version.from, object),
		decl.version.order,
		tableKey,
	);
	const deleted =
		decl.tombstone !== undefined && Boolean(extract(decl.tombstone, object));

	if (deleted) {
		const { changes } = source.tombstone.run(key, version, syncedAt);
		if (changes === 0) return 'stale';
		// A tombstone owns no derived rows.
		for (const derived of source.derivedTables) derived.clear.run(key);
		return 'tombstoned';
	}

	const values = Object.entries(decl.columns).map(([column, columnDecl]) => {
		const where = `${tableKey}.${column}`;
		const value = coerce(
			extract(columnDecl.from, object),
			columnDecl.type,
			where,
		);
		if (value === null && columnDecl.nullable !== true) {
			throw new MirrorProjectionError(
				`${where}: declared non-nullable, projected null`,
			);
		}
		return value;
	});

	const { changes } = source.upsert.run(
		key,
		version,
		0,
		syncedAt,
		...(source.retainsRaw ? [JSON.stringify(object)] : []),
		...values,
	);
	if (changes === 0) return 'stale';

	if (source.derivedTables.length > 0) {
		// Replacement, not merge. The derived set is a function of this exact
		// source version, so anything the previous version emitted must go.
		for (const derived of source.derivedTables) derived.clear.run(key);
		runDerive(source, object, key, declaration);
	}
	return 'applied';
}

function runDerive(
	source: SourceRuntime,
	object: unknown,
	sourceKey: string,
	declaration: MirrorDeclaration<TableMap>,
): void {
	const derive = (
		declaration.derive as
			| Record<string, ((object: unknown, emit: unknown) => void) | undefined>
			| undefined
	)?.[source.tableKey];
	if (derive === undefined) return;

	const emit: Record<string, (row: Record<string, unknown>) => void> = {};
	for (const derived of source.derivedTables) {
		emit[derived.tableKey] = (row) => {
			const values = Object.entries(derived.decl.columns).map(
				([column, columnDecl]) => {
					const type =
						typeof columnDecl === 'string' ? columnDecl : columnDecl.type;
					const nullable =
						typeof columnDecl === 'string'
							? false
							: columnDecl.nullable === true;
					const where = `${derived.tableKey}.${column}`;
					const value = coerce(row[column], type, where);
					if (value === null && !nullable) {
						throw new MirrorProjectionError(
							`${where}: declared non-nullable, emitted null`,
						);
					}
					return value;
				},
			);
			derived.insert.run(sourceKey, ...values);
		};
	}
	derive(object, emit);
}

// --- reader -----------------------------------------------------------------

export type MirrorReaderHandle = {
	readonly status: 'fresh';
	readonly cursor: string | null;
	readonly syncedAt: number | null;
	/**
	 * Open read-only SQL (ADR-0061). Enforced by the connection, not by parsing.
	 * There is no second typed read verb: the declaration's job is write shape
	 * and the rebuild gate, and adding typed reads beside SQL would be a
	 * duplicate surface with a weaker guarantee.
	 */
	readonly query: <TRow>(sql: string, ...params: unknown[]) => TRow[];
	readonly close: () => void;
	readonly [Symbol.dispose]: () => void;
};

/**
 * A reader never rebuilds and never stamps (ADR-0194). When the on-disk shape is
 * not this declaration's, it gets a status and no connection: it cannot read
 * rows whose columns it does not understand, because there is nothing to call.
 */
export type OpenedMirrorReader =
	| MirrorReaderHandle
	| { readonly status: 'absent' }
	| {
			readonly status: 'stale';
			readonly expected: string;
			readonly found: string | null;
	  };

export function openMirrorReader<TTables extends TableMap>(
	declaration: MirrorDeclaration<TTables>,
	options: { readonly path: string },
): OpenedMirrorReader {
	if (!existsSync(options.path)) return { status: 'absent' };

	const database = connectForReading(options.path);
	if (!hasMetaTable(database)) {
		database.close(false);
		return { status: 'absent' };
	}
	const found = readMeta(database, META_KEYS.fingerprint);
	if (found !== declaration.fingerprint) {
		database.close(false);
		return { status: 'stale', expected: declaration.fingerprint, found };
	}

	const close = () => database.close(false);
	return {
		status: 'fresh',
		get cursor() {
			return readMeta(database, META_KEYS.cursor);
		},
		get syncedAt() {
			const value = readMeta(database, META_KEYS.syncedAt);
			return value === null ? null : Number(value);
		},
		query: <TRow>(sql: string, ...params: unknown[]): TRow[] => {
			// WAL gives a snapshot per statement, not per connection, so a writer
			// may rebuild underneath a long-lived reader. Re-checking here keeps
			// "a reader never serves a shape it did not open" true for its life.
			const current = readMeta(database, META_KEYS.fingerprint);
			if (current !== declaration.fingerprint) {
				close();
				throw new MirrorSupersededError(declaration.fingerprint, current);
			}
			return database
				.query<TRow, SQLQueryBindings[]>(sql)
				.all(...(params as SQLQueryBindings[]));
		},
		close,
		[Symbol.dispose]: close,
	};
}
