/**
 * The mirror's write contract: `ingest` is monotonic, so a row only ever moves
 * forward. This is what makes the two writers (`local-books sync` and the
 * recategorize write-back) safe to race on one SQLite file: whoever writes last,
 * the newest object by QuickBooks `LastUpdatedTime` is what survives. A stale
 * write, e.g. recategorize folding its own response back after a concurrent sync
 * already ingested a newer bookkeeper edit, cannot regress the mirror.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	type BooksDb,
	MIRROR_FINGERPRINT_KEY,
	openBooksDb,
} from '../src/db.ts';
import {
	entityDef,
	MIRROR_FINGERPRINT,
	type QbObject,
} from '../src/entities.ts';
import { tempDir } from './helpers.ts';

const PURCHASE = entityDef('Purchase');

/** A Purchase whose one expense line points at `category`, optionally stamped. */
function purchase(category: string, updatedAt?: string): QbObject {
	return {
		Id: 'p1',
		SyncToken: '0',
		...(updatedAt ? { MetaData: { LastUpdatedTime: updatedAt } } : {}),
		Line: [
			{
				Id: '1',
				DetailType: 'AccountBasedExpenseLineDetail',
				AccountBasedExpenseLineDetail: { AccountRef: { value: category } },
			},
		],
	};
}

/** Open a throwaway mirror; the caller closes it. */
function openTmp(): { db: BooksDb; cleanup: () => void } {
	const tmp = tempDir();
	const db = openBooksDb(join(tmp.dir, 'books.db'));
	return { db, cleanup: () => (db.close(), tmp.cleanup()) };
}

/** The stored line category + ordering timestamp for `p1`. */
function stored(db: BooksDb): { category: string; updatedAt: string | null } {
	const row = db.raw
		.query<{ raw: string; updated_at: string | null }, []>(
			`SELECT raw, updated_at FROM purchases WHERE id = 'p1'`,
		)
		.get();
	const obj = JSON.parse(row?.raw ?? '{}');
	return {
		category:
			obj.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.value ?? '',
		updatedAt: row?.updated_at ?? null,
	};
}

/** Fold one Purchase through the write door (the single-entity, no-cursor case). */
function ingPurchase(db: BooksDb, obj: QbObject, syncedAt: string): void {
	db.ingest([{ def: PURCHASE, objects: [obj] }], { syncedAt });
}

describe('ingest is monotonic', () => {
	test('a newer object overwrites an older row', () => {
		const { db, cleanup } = openTmp();
		ingPurchase(db, purchase('60', '2026-02-01T00:00:00.000Z'), 's1');
		ingPurchase(db, purchase('77', '2026-02-02T00:00:00.000Z'), 's2');
		expect(stored(db).category).toBe('77');
		cleanup();
	});

	test('an older object does NOT regress a newer row (the Sequence B guard)', () => {
		const { db, cleanup } = openTmp();
		// A concurrent sync ingested the newer edit (category 77, T2)...
		ingPurchase(db, purchase('77', '2026-02-02T00:00:00.000Z'), 's-sync');
		// ...then a stale write-back folds its older response (category 55, T1).
		ingPurchase(db, purchase('55', '2026-02-01T00:00:00.000Z'), 's-recat');
		// The mirror keeps the newer object; the stale write is dropped.
		expect(stored(db).category).toBe('77');
		expect(stored(db).updatedAt).toBe('2026-02-02T00:00:00.000Z');
		cleanup();
	});

	test('equal timestamps apply, so a re-confirm refreshes the blob', () => {
		const { db, cleanup } = openTmp();
		const t = '2026-02-01T00:00:00.000Z';
		ingPurchase(db, purchase('60', t), 's1');
		ingPurchase(db, purchase('77', t), 's2');
		expect(stored(db).category).toBe('77');
		cleanup();
	});

	test('missing timestamps fall back to last-writer-wins (the recat fold-back path)', () => {
		const { db, cleanup } = openTmp();
		// Neither object carries MetaData (as a freshly seeded mirror + a mock QB
		// response often do not), so there is nothing to order on: apply the latest.
		ingPurchase(db, purchase('60'), 's1');
		ingPurchase(db, purchase('77'), 's2');
		expect(stored(db).category).toBe('77');
		cleanup();
	});
});

describe('the realm cursor', () => {
	test('a passed realmState advances the one cursor; rows alone do not', () => {
		const { db, cleanup } = openTmp();
		// Rows without a realmState leave the cursor untouched (the full-pull and
		// recategorize write-back path).
		ingPurchase(db, purchase('60'), 's1');
		expect(db.readRealmState().cdcCursor).toBeNull();

		// A batch that carries a realmState advances the realm cursor in the same
		// transaction as its rows (the incremental path).
		db.ingest([{ def: PURCHASE, objects: [purchase('60')] }], {
			syncedAt: 's2',
			realmState: {
				cdcCursor: '2026-02-01T00:00:00.000Z',
				lastFullPullAt: null,
				lastSyncedAt: '2026-02-01T00:00:00.000Z',
			},
		});
		expect(db.readRealmState().cdcCursor).toBe('2026-02-01T00:00:00.000Z');
		cleanup();
	});

	test('a fingerprint mismatch drops the data tables and clears the cursor', () => {
		const tmp = tempDir();
		const path = join(tmp.dir, 'books.db');
		// Seed a mirror, then forge a stale stamp + a legacy table, simulating a db
		// built under an older declaration and opened by this engine.
		let db = openBooksDb(path);
		ingPurchase(db, purchase('60'), 's1');
		db.ingest([], {
			syncedAt: 's1',
			realmState: {
				cdcCursor: '2026-02-01T00:00:00.000Z',
				lastFullPullAt: '2026-02-01T00:00:00.000Z',
				lastSyncedAt: '2026-02-01T00:00:00.000Z',
			},
		});
		db.raw.exec(
			`UPDATE _meta SET value = 'stale' WHERE key = '${MIRROR_FINGERPRINT_KEY}'`,
		);
		db.raw.exec(`CREATE TABLE _sync_state (entity TEXT PRIMARY KEY)`);
		db.close();

		// Reopening drops the derived tables (purchases, the legacy _sync_state) and
		// clears the realm cursor, so the next sync is a clean FULL.
		db = openBooksDb(path);
		expect(db.getMeta(MIRROR_FINGERPRINT_KEY)).toBe(MIRROR_FINGERPRINT);
		expect(db.readRealmState().cdcCursor).toBeNull();
		expect(db.isInitialized(PURCHASE)).toBe(false);
		const legacy = db.raw
			.query<{ n: number }, []>(
				`SELECT count(*) AS n FROM sqlite_master WHERE name='_sync_state'`,
			)
			.get();
		expect(legacy?.n).toBe(0);
		db.close();
		tmp.cleanup();
	});

	test('an unchanged declaration keeps the rows, the cursor, and any added index', () => {
		const tmp = tempDir();
		const path = join(tmp.dir, 'books.db');
		let db = openBooksDb(path);
		ingPurchase(db, purchase('60'), 's1');
		db.ingest([], {
			syncedAt: 's1',
			realmState: { cdcCursor: 'c1', lastFullPullAt: 'c1', lastSyncedAt: 'c1' },
		});
		// An index is not part of the declaration: it holds no data of its own, so
		// adding one must not cost a re-pull of the whole company.
		db.raw.exec(`CREATE INDEX idx_purchases_total ON purchases(total_amt)`);
		db.close();

		db = openBooksDb(path);
		expect(db.entityStatus(PURCHASE).rows).toBe(1);
		expect(db.readRealmState().cdcCursor).toBe('c1');
		const index = db.raw
			.query<{ n: number }, []>(
				`SELECT count(*) AS n FROM sqlite_master WHERE name='idx_purchases_total'`,
			)
			.get();
		expect(index?.n).toBe(1);
		db.close();
		tmp.cleanup();
	});

	test('a pre-fingerprint mirror rebuilds once and drops the retired key', () => {
		const tmp = tempDir();
		const path = join(tmp.dir, 'books.db');
		// The shape a mirror built by the hand-versioned engine has: rows, a cursor,
		// a `schema_version`, and no stamp at all.
		let db = openBooksDb(path);
		ingPurchase(db, purchase('60'), 's1');
		db.ingest([], {
			syncedAt: 's1',
			realmState: { cdcCursor: 'c1', lastFullPullAt: 'c1', lastSyncedAt: 'c1' },
		});
		db.raw.exec(`DELETE FROM _meta WHERE key = '${MIRROR_FINGERPRINT_KEY}'`);
		db.raw.exec(
			`INSERT INTO _meta (key, value) VALUES ('schema_version', '2')`,
		);
		db.close();

		db = openBooksDb(path);
		expect(db.isInitialized(PURCHASE)).toBe(false);
		expect(db.readRealmState().cdcCursor).toBeNull();
		expect(db.getMeta('schema_version')).toBeNull();
		expect(db.getMeta(MIRROR_FINGERPRINT_KEY)).toBe(MIRROR_FINGERPRINT);
		db.close();

		// And only once: the second open finds a matching stamp and rebuilds nothing.
		db = openBooksDb(path);
		ingPurchase(db, purchase('60'), 's2');
		db.close();
		db = openBooksDb(path);
		expect(db.entityStatus(PURCHASE).rows).toBe(1);
		db.close();
		tmp.cleanup();
	});
});

describe('a read-only handle', () => {
	test('reads, refuses writes, and never rebuilds', () => {
		const tmp = tempDir();
		const path = join(tmp.dir, 'books.db');
		// Writer seeds a mirror, then we forge a stale stamp: the next WRITER open
		// would drop everything; the next READER open must not.
		let db = openBooksDb(path);
		ingPurchase(db, purchase('60'), 's1');
		db.ingest([], {
			syncedAt: 's1',
			realmState: { cdcCursor: 'c1', lastFullPullAt: 'c1', lastSyncedAt: 'c1' },
		});
		db.raw.exec(
			`UPDATE _meta SET value = 'stale' WHERE key = '${MIRROR_FINGERPRINT_KEY}'`,
		);
		db.close();

		// A read-only handle reads the stale db untouched: the row survives, the
		// stamp is NOT refreshed, the rebuild does NOT fire, and a write is refused.
		const ro = openBooksDb(path, { readonly: true });
		expect(ro.entityStatus(PURCHASE).rows).toBe(1);
		expect(ro.readRealmState().cdcCursor).toBe('c1');
		expect(ro.getMeta(MIRROR_FINGERPRINT_KEY)).toBe('stale');
		expect(() =>
			ro.ingest([{ def: PURCHASE, objects: [purchase('61')] }], {
				syncedAt: 's2',
			}),
		).toThrow();
		expect(ro.entityStatus(PURCHASE).rows).toBe(1); // the refused write changed nothing
		ro.close();

		// A WRITER open, by contrast, rebuilds: tables dropped, stamp refreshed.
		db = openBooksDb(path);
		expect(db.getMeta(MIRROR_FINGERPRINT_KEY)).toBe(MIRROR_FINGERPRINT);
		expect(db.isInitialized(PURCHASE)).toBe(false);
		db.close();
		tmp.cleanup();
	});
});
