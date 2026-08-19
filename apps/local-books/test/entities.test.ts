/**
 * The entity projections, pinned against the real QuickBooks object shapes.
 * These are SQLite GENERATED columns over `json_extract(raw, ...)`, so the test
 * inserts a raw blob and reads the columns back: it proves the JSON paths are
 * right (header scalars only; line-level detail stays in `raw`) and that a
 * sparse object projects to nulls rather than failing the insert. The new money
 * movements pin their distinct shapes: SalesReceipt/BillPayment refs,
 * JournalEntry's column-light header (amounts are per-line in `raw`), and
 * Transfer's `Amount` (not `TotalAmt`) plus its From/To account pair.
 */

import { describe, expect, test } from 'bun:test';
import { type BooksDb, booksDbFile, openBooksDb } from '../src/db.ts';
import { entityDef, type QbObject } from '../src/entities.ts';
import { tempDir } from './helpers.ts';

/**
 * Open a throwaway mirror, upsert one object, return its projected columns.
 * The column list comes from `pragma_table_xinfo` (generated columns report
 * `hidden` 2/3), not from any TypeScript declaration: the database's own DDL
 * is the schema authority, so the test reads the schema the same way the
 * browse surface does.
 */
function project(entity: string, raw: QbObject): Record<string, unknown> {
	const def = entityDef(entity);
	const tmp = tempDir();
	let db: BooksDb | undefined;
	try {
		db = openBooksDb(booksDbFile(tmp.dir, 'r1'));
		const id = String(raw.Id);
		db.ingest([{ def, objects: [raw] }], {
			syncedAt: '2026-06-21T00:00:00.000Z',
		});
		const cols = db.raw
			.query<{ name: string }, [string]>(
				`SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)`,
			)
			.all(def.table)
			.map((c) => c.name)
			.join(', ');
		return db.raw
			.query(`SELECT ${cols} FROM ${def.table} WHERE id = ?`)
			.get(id) as Record<string, unknown>;
	} finally {
		db?.close();
		tmp.cleanup();
	}
}

describe('Purchase projection', () => {
	test('lifts the header scalars from a live-shaped object', () => {
		const purchase: QbObject = {
			Id: '855',
			TxnDate: '2026-05-21',
			TotalAmt: 200,
			PaymentType: 'Cash',
			AccountRef: { value: '11', name: 'Every Bank Account' },
			EntityRef: { value: '112', name: 'Anthropic (Expense)', type: 'Vendor' },
			Line: [
				{ AccountBasedExpenseLineDetail: { AccountRef: { name: 'IT Costs' } } },
			],
		};
		expect(project('Purchase', purchase)).toEqual({
			txn_date: '2026-05-21',
			total_amt: 200,
			payment_type: 'Cash',
			account_ref: 'Every Bank Account',
			payee: 'Anthropic (Expense)',
		});
	});

	test('a sparse object (missing fields) projects to nulls', () => {
		const sparse: QbObject = { Id: '855' };
		expect(project('Purchase', sparse)).toEqual({
			txn_date: null,
			total_amt: null,
			payment_type: null,
			account_ref: null,
			payee: null,
		});
	});
});

describe('Deposit projection', () => {
	test('reads the deposit-to account from DepositToAccountRef', () => {
		const deposit: QbObject = {
			Id: '815',
			TxnDate: '2026-02-05',
			TotalAmt: 1500,
			DepositToAccountRef: { value: '9', name: 'Arc Business account (2249)' },
			Line: [{ DepositLineDetail: { AccountRef: { name: '40000 Revenue' } } }],
		};
		expect(project('Deposit', deposit)).toEqual({
			txn_date: '2026-02-05',
			total_amt: 1500,
			deposit_to: 'Arc Business account (2249)',
		});
	});
});

describe('SalesReceipt projection', () => {
	test('lifts the cash-sale header; line items stay in raw', () => {
		const receipt: QbObject = {
			Id: '430',
			DocNumber: '1037',
			TxnDate: '2026-03-11',
			TotalAmt: 320.5,
			CustomerRef: { value: '7', name: 'Cash Customer' },
			DepositToAccountRef: { value: '35', name: 'Undeposited Funds' },
			Line: [{ SalesItemLineDetail: { ItemRef: { name: 'Consulting' } } }],
		};
		expect(project('SalesReceipt', receipt)).toEqual({
			doc_number: '1037',
			txn_date: '2026-03-11',
			total_amt: 320.5,
			customer_ref: '7',
		});
	});
});

describe('BillPayment projection', () => {
	test('lifts the money-out header; the paid bills stay in raw LinkedTxn', () => {
		const payment: QbObject = {
			Id: '512',
			TxnDate: '2026-04-02',
			TotalAmt: 1200,
			VendorRef: { value: '56', name: 'Anthropic' },
			Line: [{ Amount: 1200, LinkedTxn: [{ TxnId: '230', TxnType: 'Bill' }] }],
		};
		expect(project('BillPayment', payment)).toEqual({
			txn_date: '2026-04-02',
			total_amt: 1200,
			vendor_ref: '56',
		});
	});
});

describe('JournalEntry projection', () => {
	test('lifts only the document scalars; the debits/credits stay in raw', () => {
		const entry: QbObject = {
			Id: '904',
			DocNumber: 'JE-12',
			TxnDate: '2026-05-31',
			Line: [
				{
					Amount: 250,
					JournalEntryLineDetail: {
						PostingType: 'Debit',
						AccountRef: { name: 'Depreciation' },
					},
				},
				{
					Amount: 250,
					JournalEntryLineDetail: {
						PostingType: 'Credit',
						AccountRef: { name: 'Accumulated Depreciation' },
					},
				},
			],
		};
		expect(project('JournalEntry', entry)).toEqual({
			doc_number: 'JE-12',
			txn_date: '2026-05-31',
		});
	});
});

describe('Transfer projection', () => {
	test('reads Amount (not TotalAmt) and the From/To account pair', () => {
		const transfer: QbObject = {
			Id: '77',
			TxnDate: '2026-06-01',
			Amount: 5000,
			FromAccountRef: { value: '9', name: 'Checking' },
			ToAccountRef: { value: '12', name: 'Savings' },
		};
		expect(project('Transfer', transfer)).toEqual({
			txn_date: '2026-06-01',
			amount: 5000,
			from_account: 'Checking',
			to_account: 'Savings',
		});
	});
});
