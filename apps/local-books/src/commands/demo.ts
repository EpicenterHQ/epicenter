/**
 * `local-books demo`: build a small sample company in the local copy, with no
 * QuickBooks account and no network, then grill it so a first-time reader sees
 * the point in ten seconds. The sample lands under the `demo` realm, so it never
 * collides with a real connected company.
 *
 * This writes the same mirror shape `sync` produces (one table per record
 * type, raw QB JSON plus generated columns), so every example below is a real
 * `local-books query` you can re-run yourself.
 */

import { rmSync } from 'node:fs';
import { queryBooks } from '../books/query.ts';
import { booksDbFile, openBooksDb } from '../db.ts';
import type { DbFile } from '../db-file.ts';
import { entityDef, type QbObject } from '../entities.ts';
import { booksDataDir, companyDir } from '../paths.ts';

const DEMO_REALM = 'demo';

const account = (
	Id: string,
	Name: string,
	AccountType: string,
	CurrentBalance = 0,
): QbObject => ({ Id, Name, AccountType, CurrentBalance, Active: true });
const customer = (Id: string, DisplayName: string, Balance = 0): QbObject => ({
	Id,
	DisplayName,
	CompanyName: DisplayName,
	Active: true,
	Balance,
});
const vendor = (Id: string, DisplayName: string, Balance = 0): QbObject => ({
	Id,
	DisplayName,
	CompanyName: DisplayName,
	Active: true,
	Balance,
});
const invoice = (
	Id: string,
	customerRef: { value: string; name: string },
	TxnDate: string,
	TotalAmt: number,
	Balance: number,
): QbObject => ({
	Id,
	DocNumber: `INV-${Id}`,
	TxnDate,
	TotalAmt,
	Balance,
	CustomerRef: customerRef,
});
const bill = (
	Id: string,
	vendorRef: { value: string; name: string },
	TxnDate: string,
	TotalAmt: number,
	Balance: number,
): QbObject => ({
	Id,
	DocNumber: `BILL-${Id}`,
	TxnDate,
	TotalAmt,
	Balance,
	VendorRef: vendorRef,
});
const purchase = (
	Id: string,
	TxnDate: string,
	TotalAmt: number,
	payee: string,
	category: { value: string; name: string },
): QbObject => ({
	Id,
	TxnDate,
	TotalAmt,
	PaymentType: 'CreditCard',
	AccountRef: { value: '35', name: 'Business Checking' },
	EntityRef: { value: '0', name: payee },
	Line: [
		{
			Id: '1',
			Amount: TotalAmt,
			DetailType: 'AccountBasedExpenseLineDetail',
			AccountBasedExpenseLineDetail: { AccountRef: category },
		},
	],
});

/** Print a query's rows as a compact aligned table. */
function table(mirror: DbFile, sql: string): void {
	const { data, error } = queryBooks({ mirror, sql });
	if (error !== null) {
		console.log(`  (query failed: ${error.message})`);
		return;
	}
	if (data.rows.length === 0) {
		console.log('  (no rows)');
		return;
	}
	const cols = Object.keys(data.rows[0] as Record<string, unknown>);
	const widths = cols.map((c) =>
		Math.max(
			c.length,
			...data.rows.map(
				(r) => String((r as Record<string, unknown>)[c] ?? '').length,
			),
		),
	);
	const line = (cells: string[]) =>
		'  ' + cells.map((cell, i) => cell.padEnd(widths[i] as number)).join('  ');
	console.log(line(cols));
	console.log(line(widths.map((w) => '-'.repeat(w))));
	for (const row of data.rows) {
		console.log(
			line(cols.map((c) => String((row as Record<string, unknown>)[c] ?? ''))),
		);
	}
}

export async function runDemo(): Promise<number> {
	const dataDir = booksDataDir();
	// Fresh each run: the demo is disposable sample data, not a real mirror, so it
	// clears the whole realm directory rather than reclaiming one artifact.
	rmSync(companyDir(dataDir, DEMO_REALM), { recursive: true, force: true });
	const mirror = booksDbFile(dataDir, DEMO_REALM);

	const acme = { value: '1', name: 'Acme Corp' };
	const globex = { value: '2', name: 'Globex Inc' };
	const initech = { value: '3', name: 'Initech' };
	const aws = { value: '10', name: 'AWS' };
	const wework = { value: '13', name: 'WeWork' };

	const db = openBooksDb(mirror);
	const seed: Array<{ entity: string; objects: QbObject[] }> = [
		{
			entity: 'Account',
			objects: [
				account('35', 'Business Checking', 'Bank', 48250.75),
				account('41', 'Consulting Income', 'Income'),
				account('60', 'Uncategorized Expense', 'Expense'),
				account('61', 'Software & Subscriptions', 'Expense'),
				account('62', 'Travel', 'Expense'),
				account('64', 'Office Supplies', 'Expense'),
				account('65', 'Contractors', 'Expense'),
			],
		},
		{
			entity: 'Customer',
			objects: [
				customer('1', 'Acme Corp', 12000),
				customer('2', 'Globex Inc', 9000),
				customer('3', 'Initech', 4500),
			],
		},
		{
			entity: 'Vendor',
			objects: [
				vendor('10', 'AWS', 1800),
				vendor('13', 'WeWork', 2400),
				vendor('14', 'Staples'),
			],
		},
		{
			entity: 'Invoice',
			objects: [
				invoice('1001', acme, '2026-01-12', 8000, 0),
				invoice('1002', acme, '2026-03-04', 12000, 12000),
				invoice('1003', globex, '2026-02-18', 6000, 0),
				invoice('1004', initech, '2026-04-22', 4500, 4500),
				invoice('1005', globex, '2026-06-01', 9000, 9000),
			],
		},
		{
			entity: 'Bill',
			objects: [
				bill('5001', aws, '2026-05-05', 1800, 1800),
				bill('5002', wework, '2026-05-01', 2400, 2400),
			],
		},
		{
			entity: 'Purchase',
			objects: [
				purchase('7001', '2026-01-08', 540, 'AWS', {
					value: '61',
					name: 'Software & Subscriptions',
				}),
				purchase('7002', '2026-03-03', 1450, 'Delta Airlines', {
					value: '62',
					name: 'Travel',
				}),
				purchase('7003', '2026-03-21', 230, 'Staples', {
					value: '64',
					name: 'Office Supplies',
				}),
				purchase('7004', '2026-04-11', 4000, 'Upwork Contractor', {
					value: '65',
					name: 'Contractors',
				}),
				purchase('7005', '2026-05-18', 95, 'Unknown Vendor', {
					value: '60',
					name: 'Uncategorized Expense',
				}),
				purchase('7006', '2026-06-02', 760, 'Mystery Charge', {
					value: '60',
					name: 'Uncategorized Expense',
				}),
			],
		},
	];
	db.ingest(
		seed.map(({ entity, objects }) => ({ def: entityDef(entity), objects })),
		{
			syncedAt: new Date().toISOString(),
			// The seed is each entity's complete demo corpus, so latch them the way a
			// real full pull would; status then reports them initialized.
			fullPulled: seed.map(({ entity }) => entity),
		},
	);
	db.close();

	console.log(
		'Built a sample company (Northwind Consulting) in your local copy.',
	);
	console.log(`Stored at: ${mirror.path}\n`);

	console.log('Who owes us money? (open invoices)');
	table(
		mirror,
		`SELECT c.display_name AS customer, i.doc_number AS invoice, i.txn_date AS date,
		        printf('$%,.2f', i.balance) AS outstanding
		 FROM invoices i JOIN customers c ON c.id = i.customer_ref
		 WHERE i.deleted = 0 AND i.balance > 0 ORDER BY i.balance DESC`,
	);

	console.log('\nWhere is the money going? (expense spend by category)');
	table(
		mirror,
		`SELECT json_extract(line.value, '$.AccountBasedExpenseLineDetail.AccountRef.name') AS category,
		        COUNT(*) AS txns, printf('$%,.2f', SUM(json_extract(line.value, '$.Amount'))) AS spent
		 FROM purchases p, json_each(p.raw, '$.Line') line
		 WHERE p.deleted = 0
		 GROUP BY category ORDER BY SUM(json_extract(line.value, '$.Amount')) DESC`,
	);

	console.log('\nWhat still needs categorizing?');
	table(
		mirror,
		`SELECT id, txn_date AS date, payee, printf('$%,.2f', total_amt) AS amount
		 FROM purchases WHERE deleted = 0 AND raw LIKE '%Uncategorized Expense%' ORDER BY txn_date`,
	);

	console.log('\nTry it yourself:');
	console.log(
		'  local-books query --realm demo "SELECT display_name, balance FROM customers ORDER BY balance DESC"',
	);
	console.log(
		'  local-books query --realm demo "SELECT doc_number, total_amt, balance FROM bills WHERE balance > 0"',
	);
	console.log(
		'\nOr point an AI coding agent (Claude Code, Codex) at the file above and just ask.',
	);
	console.log(
		'With a real company connected (local-books auth), `report` and `recategorize` work against live QuickBooks.',
	);
	return 0;
}
