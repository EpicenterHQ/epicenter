import type { Database } from 'bun:sqlite';
import { type DbFile, dbFileAt } from './db-file.ts';
import {
	ENTITY_TABLES,
	type EntityDef,
	isDeleted,
	lastUpdatedTime,
	MIRROR_SCHEMA,
	type QbObject,
} from './entities.ts';
import { companyDir } from './paths.ts';

/**
 * The local mirror: one SQLite artifact per company. Holds an entity table per
 * QB type plus `_meta`, a key/value store that carries the realm's sync state.
 *
 * The whole schema is created at open: `MIRROR_SCHEMA` (the corpus contract in
 * `entities.ts`) plus `_meta`, so an artifact's schema is a pure function of
 * `MIRROR_VERSION` and the database file is self-describing from the moment it
 * exists. Anything that wants the schema asks the file (`sqlite_master`,
 * `pragma_table_xinfo`), not this module.
 *
 * CDC is a high-water-mark protocol: `changedSince` is a single timestamp for a
 * multi-entity call. So the mirror keeps ONE cursor for the whole company, not
 * one per entity, stored in `_meta` (`cdc_cursor`, `last_full_pull_at`,
 * `last_synced_at`). "Has this entity had its first full pull?" is a
 * `full_pulled:<Entity>` key in `_meta`, written in the same transaction as the
 * rows of the pull it records (see `ingest`), so latch-and-rows commit
 * together, exactly like cursor-and-rows. (ADR-0064's table-existence latch is
 * retired: tables now exist before any pull.)
 *
 * The realm owns its identity through the directory
 * (`<dataDir>/companies/<realmId>/`), not a stored column, so the db need not
 * know which company it holds. Inside that directory the artifact is named by
 * `MIRROR_VERSION` (ADR-0197), so nothing about the stored shape is stamped
 * inside the file and nothing is ever dropped on open.
 */

/** The key/value table carrying the realm's sync state. Not part of the corpus. */
const CREATE_META_TABLE = `CREATE TABLE IF NOT EXISTS _meta (
	key TEXT PRIMARY KEY,
	value TEXT
);`;

/**
 * The version of the corpus contract this build stores, and the whole of the
 * artifact's identity on disk: `books.v<MIRROR_VERSION>.db` (ADR-0197). It is
 * not the app's release version and it is not a migration target. Nothing reads
 * a lower version, and nothing rewrites one.
 *
 * Bump it when this build would store something a previous build did not: any
 * change to `MIRROR_SCHEMA` or `ENTITY_TABLES` in `entities.ts` (an added,
 * removed, or retyped column; a changed meaning for a stored column; a changed
 * entity set), since that is what a full pull covers. That is why editing the
 * corpus is not free: adding one entity is a new corpus, so it is a new
 * artifact and one full re-pull of the company.
 *
 * Do not bump it for an index, a read-time projection, a comment, or an app
 * release. None of those change what is on disk, and each bump costs a rebuild.
 *
 * v2: schema created eagerly at open; the per-entity full-pull latch moved from
 * table existence into `_meta` (`full_pulled:<Entity>`); `invoices.doc_date`
 * renamed to `txn_date` to match every other transaction table.
 */
const MIRROR_VERSION = 2;

/** The `_meta` key recording that an entity's first full pull committed. */
function fullPulledKey(entity: string): string {
	return `full_pulled:${entity}`;
}

/** The database as materialized for one company: `<dataDir>/companies/<realmId>/`. */
export function booksDbFile(dataDir: string, realmId: string): DbFile {
	return dbFileAt({
		version: MIRROR_VERSION,
		directory: companyDir(dataDir, realmId),
	});
}

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
	/** Whether this entity has been full-pulled (its `_meta` latch is set). */
	initialized: boolean;
};

export type BooksDb = ReturnType<typeof booksDb>;

/**
 * Open the company's current mirror artifact for writing, creating it if
 * absent, and declare the whole schema on it: `_meta` plus every corpus table
 * in `MIRROR_SCHEMA`, plus the `updated_at` indexes. Nothing here inspects,
 * migrates, or drops what it finds: a different corpus contract is a different
 * filename, so an artifact this opens is always one a build of this version
 * wrote (ADR-0197). The indexes are applied here and deliberately outside the
 * corpus contract: they hold no mirror facts, so adding one must not force a
 * re-pull.
 */
export function openBooksDb(file: DbFile): BooksDb {
	const db = file.open();
	db.run(CREATE_META_TABLE);
	db.run(MIRROR_SCHEMA);
	for (const table of Object.values(ENTITY_TABLES)) {
		db.run(
			`CREATE INDEX IF NOT EXISTS idx_${table}_updated_at ON ${table}(updated_at);`,
		);
	}
	return booksDb(db);
}

/**
 * The same reads against a read-only handle on the current artifact, or `null`
 * when the company has no current materialization yet. "Not built" is a state a
 * caller reports, not an error, and never a file this conjures. The connection
 * rejects every write statement, so `ingest` on this handle throws by
 * construction.
 */
export function openBooksDbReadonly(file: DbFile): BooksDb | null {
	const db = file.openReadonly();
	return db === null ? null : booksDb(db);
}

// Every table and column name interpolated below is a literal from
// `ENTITY_TABLES` or `MIRROR_SCHEMA`, never a request string; the HTTP browse
// surface (`books/read-models.ts`) resolves its table names against
// `sqlite_master` instead of trusting input.
function booksDb(db: Database) {
	const setMetaStmt = db.query(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const getMetaStmt = db.query<{ value: string | null }, [string]>(
		`SELECT value FROM _meta WHERE key = ?`,
	);

	// `db.query()` caches the compiled statement by SQL text, so the per-table
	// statements below are prepared once and reused on repeat calls without a
	// hand-rolled cache.

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

	function readRealmState(): RealmState {
		return {
			cdcCursor: getMetaStmt.get('cdc_cursor')?.value ?? null,
			lastFullPullAt: getMetaStmt.get('last_full_pull_at')?.value ?? null,
			lastSyncedAt: getMetaStmt.get('last_synced_at')?.value ?? null,
		};
	}

	function isInitialized(def: EntityDef): boolean {
		return getMetaStmt.get(fullPulledKey(def.name)) != null;
	}

	return {
		/** Escape hatch for ad-hoc queries (tests, diagnostics). */
		raw: db,

		/**
		 * The mirror's one write door: fold one or more entities' QB objects into
		 * their tables, optionally advancing the realm cursor and latching
		 * completed full pulls, all in ONE transaction. Live objects upsert,
		 * `status: "Deleted"` objects soft-delete, both monotonically (a stale
		 * write never regresses a row).
		 *
		 * The incremental sync passes every entity's CDC changes plus the new
		 * `realmState` here, so applying the whole batch and advancing the single
		 * cursor commit together (whole-batch atomic; a crash rolls back to the prior
		 * cursor and the next run re-pulls the window, which is idempotent). A
		 * per-entity full pull passes one entry plus `fullPulled: [name]`, so the
		 * latch commits with the rows it records: a crash rolls both back and the
		 * next pass backfills again. The recategorize write-back passes one entry
		 * and nothing else. The transaction is IMMEDIATE so the write lock is taken
		 * up front and a concurrent writer waits (busy_timeout) rather than racing
		 * into a mid-transaction lock failure. Returns the partition counts per
		 * entity.
		 *
		 * The caller must not pass an entity that has not been full-pulled into a
		 * CDC batch: CDC carries only changes since the cursor, so a fresh entity
		 * would silently miss history. The sync engine guards this by backfilling
		 * uninitialized entities (`isInitialized`) first.
		 */
		ingest(
			entries: IngestEntry[],
			{
				syncedAt,
				realmState,
				fullPulled,
			}: {
				syncedAt: string;
				realmState?: RealmState;
				/** Entity names whose first-full-pull latch this transaction sets. */
				fullPulled?: string[];
			},
		): IngestCounts {
			const prepared = entries.map(({ def, objects }) => {
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
				for (const entity of fullPulled ?? []) {
					setMetaStmt.run(fullPulledKey(entity), syncedAt);
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
		 * Read one live row's verbatim QB blob by id, or `null` if the row is
		 * unknown or soft-deleted. The read counterpart to `ingest`: the
		 * recategorize write-back reaches a mirror row on the write-capable handle
		 * it already holds, without hand-writing SQL against a table name.
		 */
		getLiveRaw(def: EntityDef, id: string): string | null {
			const row = db
				.query<{ raw: string }, [string]>(
					`SELECT raw FROM ${def.table} WHERE id = ? AND deleted = 0`,
				)
				.get(id);
			return row?.raw ?? null;
		},

		readRealmState,

		/** Whether this entity's first full pull has committed (`_meta` latch). */
		isInitialized,

		entityStatus(def: EntityDef): EntityStatus {
			const table = def.table;
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
				initialized: isInitialized(def),
			};
		},

		close(): void {
			db.close();
		},
	};
}
