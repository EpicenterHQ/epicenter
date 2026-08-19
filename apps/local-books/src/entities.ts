/**
 * The corpus contract: which QuickBooks entities we mirror, the SQLite table
 * each lands in, and the schema of those tables as the raw DDL it is.
 *
 * What we mirror is a rule, not a list we happened to need: every *posting*
 * QuickBooks entity (anything that moves money through the general ledger) plus
 * the name lists those transactions reference by id. Non-posting documents
 * (Estimate, PurchaseOrder) and config/attachment entities carry no money and
 * stay out. The point is completeness. The mirror is the agent's relational,
 * offline view of the books, so a *subset* would silently under-report against
 * the live statements `books_report` runs: forget BillPayment and "what did I
 * pay this vendor" is quietly wrong. It is not free, though: this file is what
 * the mirror's corpus contract covers, so changing it is a `MIRROR_VERSION`
 * bump in `db.ts`, a new artifact on disk, and one full re-pull of the company
 * (ADR-0197).
 *
 * Every table carries the same five bookkeeping columns, then its extracted
 * scalars. The raw blob is canonical; every extracted column is a GENERATED
 * projection of it (`json_extract(raw, ...)`), so there is no write-path
 * extraction and a missing field is `json_extract`'s null for free. Extracted
 * columns are an opt-in ergonomic layer, not an obligation: a table stays fully
 * queryable through `json_extract`, so lift a scalar out only where a query
 * pays for the index or join. Date and amount are the ledger spine, so the
 * money movements carry those. Line-level detail (expense categories, deposit
 * splits, journal debits/credits, linked transactions) is 1:N and stays in
 * `raw`.
 *
 * This DDL is the schema authority. The artifact's schema is a pure function
 * of `MIRROR_VERSION`: `openBooksDb` runs the whole script, so every table
 * below exists in every artifact of this version, pulled or not, and anything
 * downstream reads the schema from the database itself (`sqlite_master`,
 * `pragma_table_xinfo`) rather than from a TypeScript declaration.
 */
export const MIRROR_SCHEMA = `
-- ── Name lists: what transactions reference by id. ──

CREATE TABLE IF NOT EXISTS accounts (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	name TEXT GENERATED ALWAYS AS (json_extract(raw, '$.Name')) VIRTUAL,
	account_type TEXT GENERATED ALWAYS AS (json_extract(raw, '$.AccountType')) VIRTUAL,
	current_balance REAL GENERATED ALWAYS AS (json_extract(raw, '$.CurrentBalance')) VIRTUAL,
	active INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.Active')) VIRTUAL
);

CREATE TABLE IF NOT EXISTS customers (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	display_name TEXT GENERATED ALWAYS AS (json_extract(raw, '$.DisplayName')) VIRTUAL,
	company_name TEXT GENERATED ALWAYS AS (json_extract(raw, '$.CompanyName')) VIRTUAL,
	email TEXT GENERATED ALWAYS AS (json_extract(raw, '$.PrimaryEmailAddr.Address')) VIRTUAL,
	active INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.Active')) VIRTUAL,
	balance REAL GENERATED ALWAYS AS (json_extract(raw, '$.Balance')) VIRTUAL
);

CREATE TABLE IF NOT EXISTS vendors (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	display_name TEXT GENERATED ALWAYS AS (json_extract(raw, '$.DisplayName')) VIRTUAL,
	company_name TEXT GENERATED ALWAYS AS (json_extract(raw, '$.CompanyName')) VIRTUAL,
	active INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.Active')) VIRTUAL,
	balance REAL GENERATED ALWAYS AS (json_extract(raw, '$.Balance')) VIRTUAL
);

CREATE TABLE IF NOT EXISTS items (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	name TEXT GENERATED ALWAYS AS (json_extract(raw, '$.Name')) VIRTUAL,
	type TEXT GENERATED ALWAYS AS (json_extract(raw, '$.Type')) VIRTUAL,
	unit_price REAL GENERATED ALWAYS AS (json_extract(raw, '$.UnitPrice')) VIRTUAL,
	active INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.Active')) VIRTUAL
);

-- ── Money in: accounts-receivable and cash sales. ──

CREATE TABLE IF NOT EXISTS invoices (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	doc_number TEXT GENERATED ALWAYS AS (json_extract(raw, '$.DocNumber')) VIRTUAL,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	total_amt REAL GENERATED ALWAYS AS (json_extract(raw, '$.TotalAmt')) VIRTUAL,
	balance REAL GENERATED ALWAYS AS (json_extract(raw, '$.Balance')) VIRTUAL,
	customer_ref TEXT GENERATED ALWAYS AS (json_extract(raw, '$.CustomerRef.value')) VIRTUAL
);

CREATE TABLE IF NOT EXISTS payments (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	total_amt REAL GENERATED ALWAYS AS (json_extract(raw, '$.TotalAmt')) VIRTUAL,
	customer_ref TEXT GENERATED ALWAYS AS (json_extract(raw, '$.CustomerRef.value')) VIRTUAL
);

-- A cash / point-of-sale sale with no invoice: the money-in event an Invoice
-- never becomes. Line items live in raw.
CREATE TABLE IF NOT EXISTS sales_receipts (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	doc_number TEXT GENERATED ALWAYS AS (json_extract(raw, '$.DocNumber')) VIRTUAL,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	total_amt REAL GENERATED ALWAYS AS (json_extract(raw, '$.TotalAmt')) VIRTUAL,
	customer_ref TEXT GENERATED ALWAYS AS (json_extract(raw, '$.CustomerRef.value')) VIRTUAL
);

-- An A/R credit: reduces what a customer owes. balance is the credit not yet
-- applied to an invoice.
CREATE TABLE IF NOT EXISTS credit_memos (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	doc_number TEXT GENERATED ALWAYS AS (json_extract(raw, '$.DocNumber')) VIRTUAL,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	total_amt REAL GENERATED ALWAYS AS (json_extract(raw, '$.TotalAmt')) VIRTUAL,
	balance REAL GENERATED ALWAYS AS (json_extract(raw, '$.Balance')) VIRTUAL,
	customer_ref TEXT GENERATED ALWAYS AS (json_extract(raw, '$.CustomerRef.value')) VIRTUAL
);

-- Money refunded to a customer (the money-out counterpart of a sale).
CREATE TABLE IF NOT EXISTS refund_receipts (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	doc_number TEXT GENERATED ALWAYS AS (json_extract(raw, '$.DocNumber')) VIRTUAL,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	total_amt REAL GENERATED ALWAYS AS (json_extract(raw, '$.TotalAmt')) VIRTUAL,
	customer_ref TEXT GENERATED ALWAYS AS (json_extract(raw, '$.CustomerRef.value')) VIRTUAL
);

-- Money-in transactions (deposits, incl. posted bank-feed credits). The
-- crediting category lives in Line[].DepositLineDetail.AccountRef (1:N) and
-- stays in raw.
CREATE TABLE IF NOT EXISTS deposits (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	total_amt REAL GENERATED ALWAYS AS (json_extract(raw, '$.TotalAmt')) VIRTUAL,
	deposit_to TEXT GENERATED ALWAYS AS (json_extract(raw, '$.DepositToAccountRef.name')) VIRTUAL
);

-- ── Money out: accounts-payable and direct spend. ──

CREATE TABLE IF NOT EXISTS bills (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	doc_number TEXT GENERATED ALWAYS AS (json_extract(raw, '$.DocNumber')) VIRTUAL,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	total_amt REAL GENERATED ALWAYS AS (json_extract(raw, '$.TotalAmt')) VIRTUAL,
	balance REAL GENERATED ALWAYS AS (json_extract(raw, '$.Balance')) VIRTUAL,
	vendor_ref TEXT GENERATED ALWAYS AS (json_extract(raw, '$.VendorRef.value')) VIRTUAL
);

-- Settles one or more Bills; the bills it pays live in Line[].LinkedTxn and
-- stay in raw. This is the money-out event a Bill (an obligation) is not.
CREATE TABLE IF NOT EXISTS bill_payments (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	total_amt REAL GENERATED ALWAYS AS (json_extract(raw, '$.TotalAmt')) VIRTUAL,
	vendor_ref TEXT GENERATED ALWAYS AS (json_extract(raw, '$.VendorRef.value')) VIRTUAL
);

-- An A/P credit: reduces what you owe a vendor.
CREATE TABLE IF NOT EXISTS vendor_credits (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	doc_number TEXT GENERATED ALWAYS AS (json_extract(raw, '$.DocNumber')) VIRTUAL,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	total_amt REAL GENERATED ALWAYS AS (json_extract(raw, '$.TotalAmt')) VIRTUAL,
	vendor_ref TEXT GENERATED ALWAYS AS (json_extract(raw, '$.VendorRef.value')) VIRTUAL
);

-- Money-out transactions (card/cash/check expenses, incl. posted bank-feed
-- items). The category lives in Line[].AccountBasedExpenseLineDetail.AccountRef
-- (1:N), so it stays in raw; the extracted columns are the header scalars worth
-- grouping and joining on.
CREATE TABLE IF NOT EXISTS purchases (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	total_amt REAL GENERATED ALWAYS AS (json_extract(raw, '$.TotalAmt')) VIRTUAL,
	payment_type TEXT GENERATED ALWAYS AS (json_extract(raw, '$.PaymentType')) VIRTUAL,
	account_ref TEXT GENERATED ALWAYS AS (json_extract(raw, '$.AccountRef.name')) VIRTUAL,
	payee TEXT GENERATED ALWAYS AS (json_extract(raw, '$.EntityRef.name')) VIRTUAL
);

-- ── General ledger & banking. ──

-- Manual GL posting (adjustments, accruals). A JE has no header amount: the
-- debits and credits live per-line in Line[].JournalEntryLineDetail, so the
-- money stays in raw and only the document scalars are lifted. The honest
-- column-light case.
CREATE TABLE IF NOT EXISTS journal_entries (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	doc_number TEXT GENERATED ALWAYS AS (json_extract(raw, '$.DocNumber')) VIRTUAL,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL
);

-- Bank-to-bank movement. The QB shape differs from the others: a single Amount
-- (not TotalAmt) and a From/To account pair.
CREATE TABLE IF NOT EXISTS transfers (
	id TEXT PRIMARY KEY,
	raw TEXT NOT NULL,
	updated_at TEXT,
	synced_at TEXT NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	txn_date TEXT GENERATED ALWAYS AS (json_extract(raw, '$.TxnDate')) VIRTUAL,
	amount REAL GENERATED ALWAYS AS (json_extract(raw, '$.Amount')) VIRTUAL,
	from_account TEXT GENERATED ALWAYS AS (json_extract(raw, '$.FromAccountRef.name')) VIRTUAL,
	to_account TEXT GENERATED ALWAYS AS (json_extract(raw, '$.ToAccountRef.name')) VIRTUAL
);
`;

/**
 * The sync mapping: QuickBooks entity name (the CDC `entities` value and the
 * query endpoint) to the mirror table it lands in. Every table named here has
 * its DDL in `MIRROR_SCHEMA` above; `test/entities.test.ts` pins that the two
 * agree, so a mapping entry without a CREATE TABLE fails in CI, not at ingest.
 */
export const ENTITY_TABLES: Record<string, string> = {
	Account: 'accounts',
	Customer: 'customers',
	Vendor: 'vendors',
	Item: 'items',
	Invoice: 'invoices',
	Payment: 'payments',
	SalesReceipt: 'sales_receipts',
	CreditMemo: 'credit_memos',
	RefundReceipt: 'refund_receipts',
	Deposit: 'deposits',
	Bill: 'bills',
	BillPayment: 'bill_payments',
	VendorCredit: 'vendor_credits',
	Purchase: 'purchases',
	JournalEntry: 'journal_entries',
	Transfer: 'transfers',
};

/** One mirrored entity: its QuickBooks name and the table its rows land in. */
export type EntityDef = {
	/** QuickBooks entity name, e.g. `Invoice` (also the CDC `entities` value). */
	name: string;
	/** SQLite table name, e.g. `invoices`. */
	table: string;
};

export type QbObject = Record<string, unknown> & {
	Id?: string | number;
	status?: string;
	MetaData?: { LastUpdatedTime?: string; CreateTime?: string };
};

/** The default entities mirrored when config does not narrow the set. */
export const DEFAULT_ENTITIES: string[] = Object.keys(ENTITY_TABLES);

export function isKnownEntity(name: string): boolean {
	return name in ENTITY_TABLES;
}

export function entityDef(name: string): EntityDef {
	const table = ENTITY_TABLES[name];
	if (!table) {
		throw new Error(
			`Unknown QuickBooks entity "${name}". Known entities: ${DEFAULT_ENTITIES.join(', ')}.`,
		);
	}
	return { name, table };
}

/** A deleted CDC record carries `status: "Deleted"`; everything else is live. */
export function isDeleted(raw: QbObject): boolean {
	return (
		typeof raw.status === 'string' && raw.status.toLowerCase() === 'deleted'
	);
}

export function lastUpdatedTime(raw: QbObject): string | null {
	const value = raw.MetaData?.LastUpdatedTime;
	return typeof value === 'string' ? value : null;
}
