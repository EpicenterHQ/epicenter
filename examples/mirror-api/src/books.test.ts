/**
 * Local Books-shaped usage: a registry of uniformly-shaped QuickBooks entities,
 * one soft-deleting table each, ordered by the authority's own
 * `MetaData.LastUpdatedTime`, with one CDC cursor for the whole realm.
 *
 * Nothing here is imported from `apps/local-books`. The point is to show the
 * declaration carrying that app's shape, and the write door carrying its
 * discipline, without the app.
 */

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	defineMirror,
	type ProjectedColumn,
	type TableDeclaration,
} from './declaration.ts';
import { openMirrorWriter } from './writer.ts';

/** The registry, as `entities.ts` writes it today: QB name to table and columns. */
const ENTITIES: Record<
	string,
	{ table: string; columns: Record<string, ProjectedColumn> }
> = {
	Invoice: {
		table: 'invoices',
		columns: {
			doc_number: { type: 'TEXT', from: ['DocNumber'] },
			doc_date: { type: 'TEXT', from: ['TxnDate'] },
			total_amt: { type: 'REAL', from: ['TotalAmt'] },
			customer_ref: { type: 'TEXT', from: ['CustomerRef', 'value'] },
		},
	},
	Customer: {
		table: 'customers',
		columns: {
			display_name: { type: 'TEXT', from: ['DisplayName'] },
			balance: { type: 'REAL', from: ['Balance'] },
		},
	},
	JournalEntry: {
		// The honest column-light case: the money lives per-line inside `raw`.
		table: 'journal_entries',
		columns: { txn_date: { type: 'TEXT', from: ['TxnDate'] } },
	},
};

/**
 * Every QuickBooks table is the same shape, so the whole registry folds into a
 * declaration with one expression. A new entity is one registry entry, and the
 * gate moves on its own.
 */
const booksMirror = defineMirror({
	domain: 'epicenter.local-books.mirror',
	tables: Object.fromEntries(
		Object.values(ENTITIES).map(
			({ table, columns }): [string, TableDeclaration] => [
				table,
				{
					columns,
					orderBy: {
						column: 'updated_at',
						from: ['MetaData', 'LastUpdatedTime'],
					},
					// QuickBooks' delete means QuickBooks no longer has the object, so the
					// local blob is the only surviving copy of what it was.
					softDelete: true,
					indexes: { [`idx_${table}_updated_at`]: ['updated_at'] },
				},
			],
		),
	),
});

function invoice(id: string, updatedAt: string, total: number) {
	return {
		Id: id,
		DocNumber: `INV-${id}`,
		TxnDate: '2026-07-01',
		TotalAmt: total,
		CustomerRef: { value: 'c1', name: 'Acme' },
		MetaData: { LastUpdatedTime: updatedAt },
	};
}

function openRealm() {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	return { database, writer: openMirrorWriter(booksMirror, { database }) };
}

describe('a Local Books-shaped mirror', () => {
	let realm: ReturnType<typeof openRealm>;
	beforeEach(() => {
		realm = openRealm();
	});

	test('table existence stays the per-entity first-full-pull latch', () => {
		expect(realm.writer.opened).toBe('created');
		expect(realm.writer.exists('invoices')).toBe(false);

		realm.writer.write({ syncedAt: '2026-07-30T00:00:00Z' }, ({ table }) => {
			table('invoices').upsert({
				id: '1',
				record: invoice('1', '2026-07-01T00:00:00Z', 100),
			});
		});

		// Only the entity that was actually pulled exists. Opening the writer must
		// not create the others, or "has this entity been backfilled?" stops being
		// answerable and CDC silently skips their history.
		expect(realm.writer.exists('invoices')).toBe(true);
		expect(realm.writer.exists('customers')).toBe(false);
	});

	test('projections are queryable and the raw blob stays canonical', () => {
		realm.writer.write({ syncedAt: '2026-07-30T00:00:00Z' }, ({ table }) => {
			const invoices = table('invoices');
			invoices.upsert({
				id: '1',
				record: invoice('1', '2026-07-01T00:00:00Z', 100),
			});
			invoices.upsert({
				id: '2',
				record: invoice('2', '2026-07-02T00:00:00Z', 250),
			});
		});

		const rows = realm.writer.all<{
			id: string;
			total_amt: number;
			customer_ref: string;
		}>(`SELECT id, total_amt, customer_ref FROM invoices ORDER BY id`);

		expect(rows).toEqual([
			{ id: '1', total_amt: 100, customer_ref: 'c1' },
			{ id: '2', total_amt: 250, customer_ref: 'c1' },
		]);
		// A field nobody lifted out is still there, in `raw`.
		expect(
			realm.writer.all<{ name: string }>(
				`SELECT json_extract(raw, '$.CustomerRef.name') AS name FROM invoices WHERE id = '1'`,
			)[0]?.name,
		).toBe('Acme');
	});

	test('an incremental pass applies changes and advances the one realm cursor together', () => {
		realm.writer.write(
			{ syncedAt: '2026-07-30T00:00:00Z' },
			({ table, advance }) => {
				table('invoices').upsert({
					id: '1',
					record: invoice('1', '2026-07-01T00:00:00Z', 100),
				});
				advance({
					cursor: '2026-07-30T00:00:00Z',
					lastFullPullAt: '2026-07-30T00:00:00Z',
					lastSyncedAt: '2026-07-30T00:00:00Z',
				});
			},
		);

		realm.writer.write(
			{ syncedAt: '2026-07-31T00:00:00Z' },
			({ table, advance }) => {
				table('invoices').softDelete({
					id: '1',
					record: {
						Id: '1',
						status: 'Deleted',
						MetaData: { LastUpdatedTime: '2026-07-31T00:00:00Z' },
					},
				});
				// A CDC batch moves the cursor but not the full-pull mark.
				advance({
					cursor: '2026-07-31T00:00:00Z',
					lastSyncedAt: '2026-07-31T00:00:00Z',
				});
			},
		);

		expect(realm.writer.state()).toEqual({
			cursor: '2026-07-31T00:00:00Z',
			lastFullPullAt: '2026-07-30T00:00:00Z',
			lastSyncedAt: '2026-07-31T00:00:00Z',
		});

		// Soft delete keeps the last blob we saw, so the projections still report
		// what the record was.
		const row = realm.writer.all<{ deleted: number; total_amt: number }>(
			`SELECT deleted, total_amt FROM invoices WHERE id = '1'`,
		)[0];
		expect(row).toEqual({ deleted: 1, total_amt: 100 });
	});

	test('a stale write cannot regress a row', () => {
		realm.writer.write({ syncedAt: '2026-07-30T00:00:00Z' }, ({ table }) => {
			table('invoices').upsert({
				id: '1',
				record: invoice('1', '2026-07-30T00:00:00Z', 900),
			});
		});

		// The write-through fold of a recategorize response, landing after a sync
		// already ingested a newer bookkeeper edit.
		realm.writer.write({ syncedAt: '2026-07-31T00:00:00Z' }, ({ table }) => {
			table('invoices').upsert({
				id: '1',
				record: invoice('1', '2026-07-01T00:00:00Z', 100),
			});
		});

		expect(
			realm.writer.all<{ total_amt: number }>(
				`SELECT total_amt FROM invoices WHERE id = '1'`,
			)[0]?.total_amt,
		).toBe(900);
	});

	test('one declaration serves many realms without ever naming one', () => {
		const acme = openRealm();
		const globex = openRealm();

		acme.writer.write({ syncedAt: 't' }, ({ table, advance }) => {
			table('invoices').upsert({ id: '1', record: invoice('1', 'u', 1) });
			advance({ cursor: 'acme-cursor' });
		});
		globex.writer.write({ syncedAt: 't' }, ({ table, advance }) => {
			table('customers').upsert({
				id: '9',
				record: { Id: '9', DisplayName: 'Globex', Balance: 5 },
			});
			advance({ cursor: 'globex-cursor' });
		});

		expect(acme.writer.state().cursor).toBe('acme-cursor');
		expect(globex.writer.state().cursor).toBe('globex-cursor');
		expect(acme.writer.exists('customers')).toBe(false);
		expect(globex.writer.exists('invoices')).toBe(false);
	});

	test('a table the declaration does not know is refused by name', () => {
		expect(() =>
			realm.writer.write({ syncedAt: 't' }, ({ table }) => table('estimates')),
		).toThrow(/declares no table "estimates"/);
	});
});
