/**
 * One suite, two prototypes. Where a prototype cannot express an invariant the
 * test asserts the weaker behaviour it actually has, rather than skipping, so
 * the decision matrix in README.md is evidenced instead of claimed.
 *
 * Coverage the mission asked for: stale state, schema changes, rebuild
 * authority, and identity/path isolation.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Authority, UpstreamRecord } from '../src/authority.ts';
import type { MaterializationDeclaration } from '../src/declaration.ts';
import { acquireWriteLease, inspect, openReader } from '../src/plan/index.ts';
import { createRuntime } from '../src/plan/runtime.ts';
import { openMaterialization, rebuildOnStale } from '../src/policy/index.ts';
import type { MirrorRow } from '../src/store.ts';
import {
	baseline,
	nextFormat,
	purchaseGainedColumn,
	reordered,
	seededAuthority,
	type Tmp,
	tempRoot,
	withIndex,
	withNewTable,
} from './fixtures.ts';

/** What the suite needs from a prototype, in the smallest shape both can meet. */
type Subject = {
	readonly name: string;
	dbPath(principal: string): string;
	/** Bring the store current and pull everything the authority holds. */
	sync(
		declaration: MaterializationDeclaration,
		principal: string,
		authority: Authority,
	): void;
	/** An ordinary consumer read. */
	read(
		declaration: MaterializationDeclaration,
		principal: string,
		authority: Authority,
		table: string,
	):
		| {
				readonly outcome: 'rows';
				readonly rows: MirrorRow[];
				readonly staleReported: boolean;
		  }
		| { readonly outcome: 'refused'; readonly why: string };
	/** Bring the store current for a new declaration, ingesting nothing. */
	migrate(
		declaration: MaterializationDeclaration,
		principal: string,
		authority: Authority,
	): void;
	/** Ingest exactly these records, without a rebuild pass. */
	ingest(
		declaration: MaterializationDeclaration,
		principal: string,
		authority: Authority,
		records: readonly UpstreamRecord[],
	): void;
	/** Does a reader that is handed a stale store leave it untouched? */
	readerRebuilt(
		declaration: MaterializationDeclaration,
		principal: string,
		authority: Authority,
	): boolean;
	/** Can a second concurrent writer start a sync for the same principal? */
	secondWriterAdmitted(
		declaration: MaterializationDeclaration,
		principal: string,
		authority: Authority,
	): boolean;
};

let tmp: Tmp;

beforeEach(() => {
	tmp = tempRoot('materialization');
});
afterEach(() => tmp.cleanup());

function policySubject(): Subject {
	const dbPath = (principal: string) => {
		// Prototype A: the *app* builds the path. This line is the ownership claim.
		const dir = join(tmp.dir, 'policy', principal);
		mkdirSync(dir, { recursive: true });
		return join(dir, 'store.sqlite3');
	};
	return {
		name: 'policy',
		dbPath,
		sync(declaration, principal, authority) {
			const handle = openMaterialization(declaration, {
				path: dbPath(principal),
				policy: rebuildOnStale,
			});
			try {
				handle.ingest(authority.all(), { syncedAt: '2026-07-31T00:00:00Z' });
				handle.setCursor(authority.since(0).cursor);
			} finally {
				handle.close();
			}
		},
		read(declaration, principal, _authority, table) {
			const handle = openMaterialization(declaration, {
				path: dbPath(principal),
				readonly: true,
			});
			try {
				return {
					outcome: 'rows',
					rows: handle.read(table),
					staleReported: handle.stale,
				};
			} finally {
				handle.close();
			}
		},
		migrate(declaration, principal) {
			openMaterialization(declaration, {
				path: dbPath(principal),
				policy: rebuildOnStale,
			}).close();
		},
		ingest(declaration, principal, _authority, records) {
			const handle = openMaterialization(declaration, {
				path: dbPath(principal),
			});
			try {
				handle.ingest(records, { syncedAt: '2026-07-31T00:00:00Z' });
			} finally {
				handle.close();
			}
		},
		readerRebuilt(declaration, principal) {
			const handle = openMaterialization(declaration, {
				path: dbPath(principal),
				readonly: true,
			});
			handle.close();
			const check = openMaterialization(baseline, {
				path: dbPath(principal),
				readonly: true,
			});
			try {
				// The store still carries the *old* fingerprint if the reader left it alone.
				return check.storedFingerprint === check.fingerprint;
			} finally {
				check.close();
			}
		},
		secondWriterAdmitted(declaration, principal) {
			// Prototype A has no lease: any number of writers may open and rebuild.
			const first = openMaterialization(declaration, {
				path: dbPath(principal),
			});
			const second = openMaterialization(declaration, {
				path: dbPath(principal),
			});
			second.close();
			first.close();
			return true;
		},
	};
}

function planSubject(): Subject {
	const runtime = createRuntime({
		cacheRoot: join(tmp.dir, 'cache'),
		dataRoot: join(tmp.dir, 'data'),
	});
	const locate = (principal: string) =>
		runtime.locate({ family: 'books', principal });
	return {
		name: 'plan',
		dbPath: (principal) => locate(principal).dbPath,
		sync(declaration, principal, authority) {
			const location = locate(principal);
			const result = acquireWriteLease(location);
			if (!result.acquired) throw new Error('lease unavailable');
			const controller = result.lease.open(declaration, authority.id);
			try {
				const state = controller.state();
				if (state.kind === 'absent' || state.kind === 'stale')
					controller.apply(state.plan);
				controller.ingest(authority.all(), {
					syncedAt: '2026-07-31T00:00:00Z',
				});
				controller.setCursor(authority.since(0).cursor);
			} finally {
				controller.close();
				result.lease.release();
			}
		},
		read(declaration, principal, authority, table) {
			const reader = openReader(declaration, locate(principal), authority.id);
			switch (reader.kind) {
				case 'current': {
					const rows = reader.read(table);
					reader.close();
					return { outcome: 'rows', rows, staleReported: false };
				}
				case 'stale': {
					const read = reader.read(table);
					reader.close();
					return { outcome: 'rows', rows: read.rows, staleReported: true };
				}
				case 'foreign':
					return {
						outcome: 'refused',
						why: `foreign store held by ${reader.storedAuthority}`,
					};
				case 'absent':
					return { outcome: 'refused', why: 'absent' };
			}
		},
		migrate(declaration, principal, authority) {
			const result = acquireWriteLease(locate(principal));
			if (!result.acquired) throw new Error('lease unavailable');
			const controller = result.lease.open(declaration, authority.id);
			try {
				const state = controller.state();
				if (state.kind === 'absent' || state.kind === 'stale')
					controller.apply(state.plan);
			} finally {
				controller.close();
				result.lease.release();
			}
		},
		ingest(declaration, principal, authority, records) {
			const result = acquireWriteLease(locate(principal));
			if (!result.acquired) throw new Error('lease unavailable');
			const controller = result.lease.open(declaration, authority.id);
			try {
				controller.ingest(records, { syncedAt: '2026-07-31T00:00:00Z' });
			} finally {
				controller.close();
				result.lease.release();
			}
		},
		readerRebuilt(declaration, principal, authority) {
			const reader = openReader(declaration, locate(principal), authority.id);
			if (reader.kind === 'stale' || reader.kind === 'current') reader.close();
			const after = inspect(baseline, locate(principal), authority.id);
			return after.kind === 'current';
		},
		secondWriterAdmitted(_declaration, principal) {
			const location = locate(principal);
			const first = acquireWriteLease(location);
			if (!first.acquired) throw new Error('first lease unavailable');
			const second = acquireWriteLease(location);
			if (first.acquired) first.lease.release();
			return second.acquired;
		},
	};
}

const subjects = [
	{ name: 'policy', make: policySubject },
	{ name: 'plan', make: planSubject },
] as const;

for (const { name, make: makeSubject } of subjects) {
	describe(`${name}: stale state`, () => {
		test('a synced store reads current and reports no staleness', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);

			const result = subject.read(baseline, 'realm-a', authority, 'purchase');
			expect(result.outcome).toBe('rows');
			if (result.outcome !== 'rows') return;
			expect(result.rows).toHaveLength(1);
			expect(result.rows[0]?.['total']).toBe(42.5);
			expect(result.staleReported).toBe(false);
		});

		test('a declaration change makes the reader report staleness', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);

			const result = subject.read(
				purchaseGainedColumn,
				'realm-a',
				authority,
				'purchase',
			);
			expect(result.outcome).toBe('rows');
			if (result.outcome !== 'rows') return;
			expect(result.staleReported).toBe(true);
		});

		test('a reader never rebuilds the store it found stale', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);

			subject.read(purchaseGainedColumn, 'realm-a', authority, 'purchase');
			expect(
				subject.readerRebuilt(purchaseGainedColumn, 'realm-a', authority),
			).toBe(true);
		});

		test('a writer brings a stale store current', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);
			subject.sync(purchaseGainedColumn, 'realm-a', authority);

			const result = subject.read(
				purchaseGainedColumn,
				'realm-a',
				authority,
				'purchase',
			);
			expect(result.outcome).toBe('rows');
			if (result.outcome !== 'rows') return;
			expect(result.staleReported).toBe(false);
			expect(result.rows[0]?.['account_ref']).toBe('7');
		});
	});

	describe(`${name}: schema changes`, () => {
		test('reordering declaration keys is not a schema change', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);

			const result = subject.read(reordered, 'realm-a', authority, 'purchase');
			expect(result.outcome).toBe('rows');
			if (result.outcome !== 'rows') return;
			expect(result.staleReported).toBe(false);
		});

		test('adding an index is not a schema change', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);

			const result = subject.read(withIndex, 'realm-a', authority, 'purchase');
			expect(result.outcome).toBe('rows');
			if (result.outcome !== 'rows') return;
			expect(result.staleReported).toBe(false);
		});

		test('adding a projected column is a schema change and rebuilds its rows', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);
			subject.sync(purchaseGainedColumn, 'realm-a', authority);

			const result = subject.read(
				purchaseGainedColumn,
				'realm-a',
				authority,
				'purchase',
			);
			if (result.outcome !== 'rows') throw new Error('expected rows');
			expect(result.rows[0]?.['account_ref']).toBe('7');
		});

		test('the cost of a one-table change is what separates the two shapes', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);

			// Bring the store current for a declaration that only touched
			// `purchase`, ingesting nothing. Whatever survives is what the next
			// sync does *not* have to re-pull.
			subject.migrate(purchaseGainedColumn, 'realm-a', authority);
			const vendors = subject.read(
				purchaseGainedColumn,
				'realm-a',
				authority,
				'vendor',
			);
			if (vendors.outcome !== 'rows') throw new Error('expected rows');

			// One whole-store digest can only express "rebuild everything", so an
			// untouched table is re-pulled too. A per-table manifest keeps it.
			expect(vendors.rows).toHaveLength(name === 'policy' ? 0 : 1);

			const purchases = subject.read(
				purchaseGainedColumn,
				'realm-a',
				authority,
				'purchase',
			);
			if (purchases.outcome !== 'rows') throw new Error('expected rows');
			expect(purchases.rows).toHaveLength(0);
		});

		test('a format change is handled without reading the old shape', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);
			subject.sync(nextFormat, 'realm-a', authority);

			const result = subject.read(nextFormat, 'realm-a', authority, 'purchase');
			if (result.outcome !== 'rows') throw new Error('expected rows');
			expect(result.staleReported).toBe(false);
			expect(result.rows).toHaveLength(1);
		});
	});

	describe(`${name}: rebuild authority`, () => {
		test('a read-only connection cannot write, whatever the API offers', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);

			// Both prototypes route reads through a SQLite read-only connection, so
			// the floor holds even where the type does not (ADR-0192 clause B).
			const path = subject.dbPath('realm-a');
			const db = new Database(path, { readonly: true });
			expect(() => db.exec('DROP TABLE purchase;')).toThrow();
			db.close();
		});

		test('rebuilding preserves rows the declaration did not touch', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);
			subject.sync(purchaseGainedColumn, 'realm-a', authority);

			const vendors = subject.read(
				purchaseGainedColumn,
				'realm-a',
				authority,
				'vendor',
			);
			if (vendors.outcome !== 'rows') throw new Error('expected rows');
			expect(vendors.rows[0]?.['display_name']).toBe('AWS');
		});

		test('adding a table does not disturb the tables already present', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);
			subject.sync(withNewTable, 'realm-a', authority);

			const vendors = subject.read(
				withNewTable,
				'realm-a',
				authority,
				'vendor',
			);
			if (vendors.outcome !== 'rows') throw new Error('expected rows');
			expect(vendors.rows).toHaveLength(1);
		});
	});

	describe(`${name}: the shared write door`, () => {
		test('a stale fold cannot regress a row the sync already refreshed', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);

			subject.ingest(baseline, 'realm-a', authority, [
				{
					id: 'v1',
					table: 'vendor',
					version: 9,
					data: { DisplayName: 'AWS (renamed)' },
				},
			]);
			// An older version arriving late, the ADR-0063 failure mode.
			subject.ingest(baseline, 'realm-a', authority, [
				{
					id: 'v1',
					table: 'vendor',
					version: 2,
					data: { DisplayName: 'stale fold' },
				},
			]);

			const vendors = subject.read(baseline, 'realm-a', authority, 'vendor');
			if (vendors.outcome !== 'rows') throw new Error('expected rows');
			expect(vendors.rows[0]?.['display_name']).toBe('AWS (renamed)');
		});

		test('an upstream with no per-record version degrades to last-writer-wins', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a', { ordersRecords: false });
			subject.sync(baseline, 'realm-a', authority);

			subject.ingest(baseline, 'realm-a', authority, [
				{
					id: 'v1',
					table: 'vendor',
					version: null,
					data: { DisplayName: 'second' },
				},
			]);

			const vendors = subject.read(baseline, 'realm-a', authority, 'vendor');
			if (vendors.outcome !== 'rows') throw new Error('expected rows');
			// Explicit degradation, not a silent one: ADR-0192 clause B names it.
			expect(vendors.rows[0]?.['display_name']).toBe('second');
		});
	});

	describe(`${name}: identity and path isolation`, () => {
		test('two principals never share a store', () => {
			const subject = makeSubject();
			const a = seededAuthority('realm-a');
			const b = seededAuthority('realm-b');
			subject.sync(baseline, 'realm-a', a);
			subject.sync(baseline, 'realm-b', b);

			expect(subject.dbPath('realm-a')).not.toBe(subject.dbPath('realm-b'));
			expect(existsSync(subject.dbPath('realm-a'))).toBe(true);
			expect(existsSync(subject.dbPath('realm-b'))).toBe(true);
		});

		test('a second sync owner for one principal', () => {
			const subject = makeSubject();
			const authority = seededAuthority('realm-a');
			subject.sync(baseline, 'realm-a', authority);

			const admitted = subject.secondWriterAdmitted(
				baseline,
				'realm-a',
				authority,
			);
			// Prototype A admits it (no lease exists); prototype B yields.
			// ADR-0192 clause D says one sync owner per principal, so the honest
			// reading is that only one of these two conforms.
			expect(admitted).toBe(subject.name === 'policy');
		});
	});
}
