/**
 * The mirror's write contract: `ingest` is monotonic, so a row only ever moves
 * forward. This is what makes the two writers (`local-books sync` and the
 * recategorize write-back) safe to race on one SQLite file: whoever writes last,
 * the newest object by QuickBooks `LastUpdatedTime` is what survives. A stale
 * write, e.g. recategorize folding its own response back after a concurrent sync
 * already ingested a newer bookkeeper edit, cannot regress the mirror.
 *
 * The other half is what opening does NOT do. Since the artifact is named by the
 * corpus version that builds it (ADR-0197), open is pure creation: no stored
 * version to compare, no tables to drop, no cursor to clear.
 */

import { describe, expect, test } from 'bun:test';
import {
	type BooksDb,
	booksDbFile,
	openBooksDb,
	openBooksDbReadonly,
} from '../src/db.ts';
import { DEFAULT_ENTITIES, entityDef, type QbObject } from '../src/entities.ts';
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
	const db = openBooksDb(booksDbFile(tmp.dir, 'r1'));
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

	test('reopening a writer preserves the rows, the cursor, and the latch', () => {
		const tmp = tempDir();
		const mirror = booksDbFile(tmp.dir, 'r1');
		let db = openBooksDb(mirror);
		db.ingest([{ def: PURCHASE, objects: [purchase('60')] }], {
			syncedAt: 's1',
			fullPulled: ['Purchase'],
			realmState: {
				cdcCursor: '2026-02-01T00:00:00.000Z',
				lastFullPullAt: '2026-02-01T00:00:00.000Z',
				lastSyncedAt: '2026-02-01T00:00:00.000Z',
			},
		});
		db.close();

		// Nothing is inspected, dropped, or migrated on open: a different corpus
		// version would be a different filename, so an artifact this opens is always
		// one this build wrote (ADR-0197). Opening five times from five call sites
		// is safe.
		db = openBooksDb(mirror);
		expect(db.readRealmState().cdcCursor).toBe('2026-02-01T00:00:00.000Z');
		expect(db.isInitialized(PURCHASE)).toBe(true);
		expect(db.entityStatus(PURCHASE).rows).toBe(1);
		// Nothing about the stored shape is stamped in the file: `_meta` carries the
		// realm cursor and the per-entity full-pull latches, nothing else.
		expect(
			db.raw
				.query<{ key: string }, []>(`SELECT key FROM _meta ORDER BY key`)
				.all()
				.map((r) => r.key),
		).toEqual([
			'cdc_cursor',
			'full_pulled:Purchase',
			'last_full_pull_at',
			'last_synced_at',
		]);
		db.close();
		tmp.cleanup();
	});
});

describe('the schema is created at open', () => {
	test('every mapped table exists with the bookkeeping columns before any pull', () => {
		const { db, cleanup } = openTmp();
		// The artifact's schema is a pure function of MIRROR_VERSION: the whole
		// corpus exists from the moment the file does, pulled or not, and the shared
		// upsert in `ingest` depends on these five columns in every table. This is
		// also the ENTITY_TABLES <-> MIRROR_SCHEMA drift guard: a mapping entry
		// without a CREATE TABLE fails here.
		for (const name of DEFAULT_ENTITIES) {
			const def = entityDef(name);
			const columns = db.raw
				.query<{ name: string; pk: number }, [string]>(
					`SELECT name, pk FROM pragma_table_xinfo(?)`,
				)
				.all(def.table);
			const byName = new Map(columns.map((c) => [c.name, c]));
			for (const required of [
				'id',
				'raw',
				'updated_at',
				'synced_at',
				'deleted',
			]) {
				expect(byName.has(required)).toBe(true);
			}
			expect(byName.get('id')?.pk).toBe(1);
		}
		cleanup();
	});

	test('the full-pull latch is ingest state, not table existence', () => {
		const { db, cleanup } = openTmp();
		// The table exists (created at open) but nothing has been pulled...
		expect(db.isInitialized(PURCHASE)).toBe(false);
		// ...and rows alone (a CDC batch, a recategorize fold) do not latch it.
		ingPurchase(db, purchase('60'), 's1');
		expect(db.isInitialized(PURCHASE)).toBe(false);
		// Only a pass that declares itself a full pull does.
		db.ingest([], { syncedAt: 's2', fullPulled: ['Purchase'] });
		expect(db.isInitialized(PURCHASE)).toBe(true);
		cleanup();
	});
});

describe('a read-only handle', () => {
	test('is null before the mirror is built, and never creates it', () => {
		const tmp = tempDir();
		const mirror = booksDbFile(tmp.dir, 'r1');
		expect(openBooksDbReadonly(mirror)).toBeNull();
		expect(openBooksDbReadonly(mirror)).toBeNull();
		tmp.cleanup();
	});

	test('reads the mirror and refuses writes by the connection', () => {
		const tmp = tempDir();
		const mirror = booksDbFile(tmp.dir, 'r1');
		const db = openBooksDb(mirror);
		ingPurchase(db, purchase('60'), 's1');
		db.ingest([], {
			syncedAt: 's1',
			realmState: { cdcCursor: 'c1', lastFullPullAt: 'c1', lastSyncedAt: 'c1' },
		});
		db.close();

		const ro = openBooksDbReadonly(mirror);
		if (!ro) throw new Error('the mirror was just built');
		expect(ro.entityStatus(PURCHASE).rows).toBe(1);
		expect(ro.readRealmState().cdcCursor).toBe('c1');
		expect(() =>
			ro.ingest([{ def: PURCHASE, objects: [purchase('61')] }], {
				syncedAt: 's2',
			}),
		).toThrow();
		expect(ro.entityStatus(PURCHASE).rows).toBe(1); // the refused write changed nothing
		ro.close();
		tmp.cleanup();
	});
});
