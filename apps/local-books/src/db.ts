import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	type EntityDef,
	isDeleted,
	type JsonPathSegment,
	lastUpdatedTime,
	MIRROR_DECLARATION,
	type QbObject,
	sqlIdent,
} from './entities.ts';
import { fingerprintDeclaration } from './fingerprint.ts';

/**
 * The local mirror: one SQLite file per company. Holds an entity table per QB
 * type plus `_meta`, a key/value store that carries the mirror fingerprint and
 * realm's sync state.
 *
 * CDC is a high-water-mark protocol: `changedSince` is a single timestamp for a
 * multi-entity call. So the mirror keeps ONE cursor for the whole company, not
 * one per entity, stored in `_meta` (`cdc_cursor`, `last_full_pull_at`,
 * `last_synced_at`). "Has this entity had its first full pull?" is answered by
 * whether its table exists, so there is no per-entity sync-state table: the
 * tables themselves are the initialization latch. The cursor advances in the
 * same transaction as the rows it accounts for (see `ingest`), so
 * ingest-and-advance is atomic and crash-safe.
 *
 * The realm owns its identity through the path (`<dataDir>/<realmId>/books.db`),
 * not a stored column, so the db need not know which company it holds.
 */

export const MIRROR_FINGERPRINT = fingerprintDeclaration(
	'epicenter.local-books.mirror/v1',
	MIRROR_DECLARATION,
);

/** The `_meta` keys that hold the realm's one sync cursor. */
const CURSOR_KEYS = [
	'cdc_cursor',
	'last_full_pull_at',
	'last_synced_at',
] as const;

const RETIRED_META_KEYS = ['schema_version'] as const;

/**
 * The whole company's CDC position, the single high-water mark. `cdcCursor` is
 * the `changedSince` the next incremental pass passes; `lastFullPullAt` drives
 * the staleness backstop; `lastSyncedAt` is informational. Any field is null
 * before the first sync writes it.
 */
export type RealmState = {
	cdcCursor: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

/**
 * One row destined for an entity table, keyed by QB `id`: the blob plus the
 * timestamp the mirror orders writes by. Built inside `ingest` from a QB object;
 * the destiny (upsert vs soft-delete) is the array it lands in, not the type. The
 * extracted columns are generated from `raw`, so no row carries them.
 */
type MirrorRow = {
	id: string;
	raw: string;
	updatedAt: string | null;
};

/** One entity's slice of an ingest batch: its def and the QB objects to fold in. */
export type IngestEntry = { def: EntityDef; objects: QbObject[] };

/** The partition counts an ingest produced, keyed by QB entity name. */
export type IngestCounts = Record<
	string,
	{ upserted: number; deleted: number }
>;

export type EntityStatus = {
	entity: string;
	rows: number;
	deleted: number;
	/** Whether this entity has been full-pulled (its table exists). */
	initialized: boolean;
};

// The registry (`entities.ts`) is the SQL-identifier boundary: it validates and
// brands every table name, generated-column name (`SqlIdent`), and path segment
// (`JsonPathSegment`) when it is built, so this module interpolates registry
// values into SQL without re-checking them. `sqlIdent` is reused at exactly one
// site below, the schema-migration drop, whose table names come from
// `sqlite_master` rather than the registry.
function jsonExtractPath(segments: JsonPathSegment[]): string {
	return `$.${segments.join('.')}`;
}

export type BooksDb = ReturnType<typeof openBooksDb>;

export function openBooksDb(
	path: string,
	{ readonly = false }: { readonly?: boolean } = {},
) {
	// A read-only handle (status, diagnostics) opens the existing file and touches
	// nothing: no journal-mode change, no `_meta` creation, no fingerprint
	// write, and crucially no drop-migration. A reader must never mutate the mirror
	// or, worse, drop its tables, and must not fail with SQLITE_BUSY just to bump a
	// bookkeeping row while a sync holds the write lock. The connection rejects any
	// write statement, so `ingest` on a read-only handle throws by construction.
	if (!readonly) mkdirSync(dirname(path), { recursive: true });
	const db = new Database(
		path,
		readonly ? { readonly: true } : { create: true },
	);
	if (readonly) {
		db.exec('PRAGMA busy_timeout = 5000;');
	} else {
		// The mirror's concurrency contract, set once for every writer connection.
		// The daemon's recategorize write-back and `local-books sync` are separate
		// processes on one file, so: WAL (readers never block the writer), a
		// busy_timeout (a writer waits for a concurrent writer's lock instead of
		// failing instantly with SQLITE_BUSY), and synchronous=NORMAL (the mirror is
		// a re-pullable cache, so a lost last-commit on power loss just re-pulls; it
		// cannot corrupt the ledger, which QuickBooks owns).
		db.exec('PRAGMA journal_mode = WAL;');
		db.exec('PRAGMA busy_timeout = 5000;');
		db.exec('PRAGMA synchronous = NORMAL;');
		db.exec('PRAGMA foreign_keys = ON;');
		db.exec(
			`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);`,
		);
	}

	const setMetaStmt = db.query(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const getMetaStmt = db.query<{ value: string | null }, [string]>(
		`SELECT value FROM _meta WHERE key = ?`,
	);

	// Fingerprint gate (writers only). The mirror is a re-pullable cache
	// QuickBooks owns the truth for, so a format change carries no migration
	// reader: on a mismatch we drop the derived tables and clear the cursor, and
	// the next sync rebuilds with one `sync --full`. That asymmetric win is what
	// lets the schema change for free. A read-only handle never runs this: it
	// cannot write, and a reader has no business dropping tables.
	if (!readonly) {
		const storedFingerprint =
			getMetaStmt.get('mirror_fingerprint')?.value ?? null;
		if (storedFingerprint !== MIRROR_FINGERPRINT) {
			for (const { name } of db
				.query<{ name: string }, []>(
					`SELECT name FROM sqlite_master
					 WHERE type='table' AND name != '_meta' AND name NOT LIKE 'sqlite_%'`,
				)
				.all()) {
				db.exec(`DROP TABLE IF EXISTS ${sqlIdent(name)};`);
			}
			// These are compile-time constants, so interpolating them as quoted
			// literals is safe (no user input reaches this string).
			db.exec(
				`DELETE FROM _meta WHERE key IN (${[
					...CURSOR_KEYS,
					...RETIRED_META_KEYS,
				]
					.map((k) => `'${k}'`)
					.join(', ')});`,
			);
		}
		setMetaStmt.run('mirror_fingerprint', MIRROR_FINGERPRINT);
	}

	// `db.query()` caches the compiled statement by SQL text, so the per-table
	// statements below are prepared once and reused on repeat calls without a
	// hand-rolled cache.

	function ensureEntityTable(def: EntityDef): void {
		const table = def.table;
		// Each extracted column is a VIRTUAL generated projection of `raw`, so the
		// blob stays the single source of truth: no write-path extraction, and a
		// missing field is `json_extract`'s null for free.
		const extra = def.columns
			.map(
				(c) =>
					`${c.name} ${c.type} GENERATED ALWAYS AS (json_extract(raw, '${jsonExtractPath(c.path)}')) VIRTUAL`,
			)
			.join(',\n\t\t\t\t');
		db.exec(`
			CREATE TABLE IF NOT EXISTS ${table} (
				id          TEXT PRIMARY KEY,
				raw         TEXT NOT NULL,
				updated_at  TEXT,
				synced_at   TEXT NOT NULL,
			deleted     INTEGER NOT NULL DEFAULT 0${extra ? `,\n\t\t\t\t${extra}` : ''}
			);
			CREATE INDEX IF NOT EXISTS idx_${table}_updated_at ON ${table}(updated_at);
		`);
	}

	function upsertStmtFor(def: EntityDef) {
		const table = def.table;
		// Monotonic upsert: a row only ever moves forward. The DO UPDATE applies only
		// when the incoming object is at least as new as the stored one (by QB
		// LastUpdatedTime), so a stale write cannot regress the mirror, e.g.
		// recategorize folding its own response back after a concurrent sync already
		// ingested a newer bookkeeper edit. A missing timestamp on either side falls
		// back to last-writer-wins (nothing to order on). The extracted columns are
		// generated from `raw`, so the upsert writes only the blob and its bookkeeping.
		return db.query(
			`INSERT INTO ${table} (id, raw, updated_at, synced_at, deleted)
			 VALUES (?, ?, ?, ?, 0)
			 ON CONFLICT(id) DO UPDATE SET
			   raw = excluded.raw,
			   updated_at = excluded.updated_at,
			   synced_at = excluded.synced_at,
			   deleted = 0
			 WHERE excluded.updated_at IS NULL
			    OR ${table}.updated_at IS NULL
			    OR excluded.updated_at >= ${table}.updated_at`,
		);
	}

	function deleteStmtFor(def: EntityDef) {
		const table = def.table;
		// On conflict, only flip the flag + timestamps and keep the existing blob (a
		// CDC delete payload is just a stub); the generated columns keep projecting
		// that preserved blob, so the last-known scalars survive. Same monotonic guard
		// as the upsert: a stale delete cannot override a newer live update.
		return db.query(
			`INSERT INTO ${table} (id, raw, updated_at, synced_at, deleted)
			 VALUES (?, ?, ?, ?, 1)
			 ON CONFLICT(id) DO UPDATE SET
			   deleted = 1,
			   synced_at = excluded.synced_at,
			   updated_at = excluded.updated_at
			 WHERE excluded.updated_at IS NULL
			    OR ${table}.updated_at IS NULL
			    OR excluded.updated_at >= ${table}.updated_at`,
		);
	}

	function tableExists(name: string): boolean {
		const row = db
			.query<{ n: number }, [string]>(
				`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`,
			)
			.get(name);
		return (row?.n ?? 0) > 0;
	}

	function readRealmState(): RealmState {
		return {
			cdcCursor: getMetaStmt.get('cdc_cursor')?.value ?? null,
			lastFullPullAt: getMetaStmt.get('last_full_pull_at')?.value ?? null,
			lastSyncedAt: getMetaStmt.get('last_synced_at')?.value ?? null,
		};
	}

	return {
		/** Escape hatch for ad-hoc queries (tests, diagnostics). */
		raw: db,

		/**
		 * The mirror's one write door: fold one or more entities' QB objects into
		 * their tables, optionally advancing the realm cursor, all in ONE
		 * transaction. Live objects upsert, `status: "Deleted"` objects soft-delete,
		 * both monotonically (a stale write never regresses a row).
		 *
		 * The incremental sync passes every entity's CDC changes plus the new
		 * `realmState` here, so applying the whole batch and advancing the single
		 * cursor commit together (whole-batch atomic; a crash rolls back to the prior
		 * cursor and the next run re-pulls the window, which is idempotent). A
		 * per-entity full pull and the recategorize write-back pass one entry and no
		 * `realmState` (the cursor advances at the end of the full pass instead). The
		 * transaction is IMMEDIATE so the write lock is taken up front and a
		 * concurrent writer waits (busy_timeout) rather than racing into a
		 * mid-transaction lock failure. Returns the partition counts per entity.
		 *
		 * `ensureEntityTable` runs for every entry, so the caller must not pass an
		 * entity that has not been full-pulled into a CDC batch: CDC carries only
		 * changes since the cursor, so a fresh table would silently miss history.
		 * The sync engine guards this by backfilling uninitialized entities first.
		 */
		ingest(
			entries: IngestEntry[],
			{ syncedAt, realmState }: { syncedAt: string; realmState?: RealmState },
		): IngestCounts {
			const prepared = entries.map(({ def, objects }) => {
				ensureEntityTable(def);
				const upserts: MirrorRow[] = [];
				const deletes: MirrorRow[] = [];
				for (const obj of objects) {
					const id = obj.Id != null ? String(obj.Id) : null;
					if (!id) continue; // skip malformed objects with no Id
					const row: MirrorRow = {
						id,
						raw: JSON.stringify(obj),
						updatedAt: lastUpdatedTime(obj),
					};
					(isDeleted(obj) ? deletes : upserts).push(row);
				}
				return {
					def,
					upsert: upsertStmtFor(def),
					markDeleted: deleteStmtFor(def),
					upserts,
					deletes,
				};
			});

			const counts: IngestCounts = {};
			for (const p of prepared) {
				counts[p.def.name] = {
					upserted: p.upserts.length,
					deleted: p.deletes.length,
				};
			}

			const tx = db.transaction(() => {
				for (const p of prepared) {
					for (const row of p.upserts) {
						p.upsert.run(row.id, row.raw, row.updatedAt, syncedAt);
					}
					for (const row of p.deletes) {
						p.markDeleted.run(row.id, row.raw, row.updatedAt, syncedAt);
					}
				}
				if (realmState) {
					setMetaStmt.run('cdc_cursor', realmState.cdcCursor);
					setMetaStmt.run('last_full_pull_at', realmState.lastFullPullAt);
					setMetaStmt.run('last_synced_at', realmState.lastSyncedAt);
				}
			});
			tx.immediate();

			return counts;
		},

		/**
		 * Read one live row's verbatim QB blob by id, or `null` if the entity table
		 * does not exist yet, the row is unknown, or it is soft-deleted. The read
		 * counterpart to `ingest`: callers reach a mirror row without hand-writing SQL
		 * against a table name. (`queryBooks` keeps its own read-only connection for
		 * arbitrary queries; this serves the write-capable handle the recategorize
		 * write-back already holds.)
		 */
		getLiveRaw(def: EntityDef, id: string): string | null {
			if (!tableExists(def.table)) return null;
			const row = db
				.query<{ raw: string }, [string]>(
					`SELECT raw FROM ${def.table} WHERE id = ? AND deleted = 0`,
				)
				.get(id);
			return row?.raw ?? null;
		},

		readRealmState,

		/**
		 * A page of an entity's rows, newest first, for the browse surface. Returns
		 * the id, the bookkeeping columns, and this entity's extracted scalar columns
		 * (not `raw`, which is heavy and only the detail view needs), plus the total
		 * row count so a caller can page. An entity with no table yet is empty, not an
		 * error. The column list is built from the registry def, so every name is a
		 * static identifier; SQLite sorts NULL `updated_at` last under DESC, so
		 * never-dated rows fall to the bottom.
		 */
		pageRows(
			def: EntityDef,
			{ limit, offset }: { limit: number; offset: number },
		): { rows: Record<string, unknown>[]; total: number } {
			const table = def.table;
			if (!tableExists(def.table)) return { rows: [], total: 0 };
			const total =
				db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()
					?.n ?? 0;
			const cols = [
				'id',
				'updated_at',
				'synced_at',
				'deleted',
				...def.columns.map((c) => c.name),
			].join(', ');
			const rows = db
				.query(
					`SELECT ${cols} FROM ${table} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
				)
				.all(limit, offset) as Record<string, unknown>[];
			return { rows, total };
		},

		/**
		 * One row by id with its verbatim `raw` blob, for the detail view. Unlike
		 * `getLiveRaw`, this returns soft-deleted rows too (the mirror still holds the
		 * last-known blob), so the UI can show a removed record. `null` when the table
		 * or the row does not exist.
		 */
		getRow(def: EntityDef, id: string): Record<string, unknown> | null {
			if (!tableExists(def.table)) return null;
			const row = db.query(`SELECT * FROM ${def.table} WHERE id = ?`).get(id);
			return (row as Record<string, unknown>) ?? null;
		},

		/** Whether this entity has had its first full pull, i.e. its table exists. */
		isInitialized(def: EntityDef): boolean {
			return tableExists(def.table);
		},

		getMeta(key: string): string | null {
			return getMetaStmt.get(key)?.value ?? null;
		},

		entityStatus(def: EntityDef): EntityStatus {
			const table = def.table;
			if (!tableExists(def.table)) {
				return {
					entity: def.name,
					rows: 0,
					deleted: 0,
					initialized: false,
				};
			}
			const rows = db
				.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
				.get();
			const deleted = db
				.query<{ n: number }, []>(
					`SELECT count(*) AS n FROM ${table} WHERE deleted = 1`,
				)
				.get();
			return {
				entity: def.name,
				rows: rows?.n ?? 0,
				deleted: deleted?.n ?? 0,
				initialized: true,
			};
		},

		close(): void {
			db.close();
		},
	};
}
