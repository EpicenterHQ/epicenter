/**
 * The QuickBooks entity registry: which QB types we mirror, the SQLite table
 * each lands in, and (optionally) the scalar columns worth lifting out of the
 * raw blob for indexing and joins.
 *
 * What we mirror is a rule, not a list we happened to need: every *posting*
 * QuickBooks entity (anything that moves money through the general ledger) plus
 * the name lists those transactions reference by id. Non-posting documents
 * (Estimate, PurchaseOrder) and config/attachment entities carry no money and
 * stay out. The point is completeness. The mirror is the agent's relational,
 * offline view of the books, so a *subset* would silently under-report against
 * the live statements `books_report` runs: forget BillPayment and "what did I
 * pay this vendor" is quietly wrong. Adding an entity is one entry here with no
 * migration to write, so there is no reason to curate below the full posting
 * set. It is not free, though: this registry is what the mirror's corpus
 * contract covers (`db.ts`), so adding or changing an entity here is a
 * `MIRROR_VERSION` bump, a new artifact on disk, and one full re-pull of the
 * company (ADR-0197).
 *
 * The raw blob is canonical; extracted columns are pure projections of it, each
 * a SQLite GENERATED column over `json_extract(raw, ...)` (see `db.ts`). So the
 * registry is plain data: a JSON path and the type SQLite coerces it to, with no
 * write-path extraction and no delete-stub case (a missing field is
 * `json_extract`'s `null` for free). Columns are therefore an opt-in ergonomic
 * layer, not an obligation: an entity may ship with `columns: []` and stay fully
 * queryable through `json_extract`; lift a scalar out only where a query pays for
 * the index or join. Date and amount are the ledger spine, so the money
 * movements carry those.
 */

export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';

/**
 * A validated SQLite identifier: a mirror table name or a generated-column name.
 * Lowercase snake-case, so it is safe to interpolate straight into DDL/DML. The
 * brand records that the string passed `sqlIdent` when the registry was built, so
 * `db.ts` consumes registry identifiers without re-checking them at every edge.
 */
export type SqlIdent = string & { readonly __brand: 'SqlIdent' };

/**
 * A validated segment of a `json_extract` path, i.e. one QuickBooks field name
 * (PascalCase). Checked by `jsonPathSegment` so the whole path can be inlined
 * into the generated column's `json_extract(raw, '$.A.B')` string literal.
 */
export type JsonPathSegment = string & { readonly __brand: 'JsonPathSegment' };

/** SQLite identifiers we mint: lowercase snake-case, no quotes, dots, or `$`. */
const SQL_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Validate and brand a SQLite identifier, throwing on anything unsafe. The
 * registry is a closed set of literals, so this only ever fires on a bad
 * hand-written entry; `db.ts` reuses it for the one identifier it authors
 * itself, the `_meta` table.
 */
export function sqlIdent(name: string): SqlIdent {
	if (!SQL_IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
	return name as SqlIdent;
}

// QB field segments are PascalCase, so this admits mixed case, unlike `SqlIdent`.
const JSON_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function jsonPathSegment(segment: string): JsonPathSegment {
	if (!JSON_PATH_SEGMENT.test(segment)) {
		throw new Error(`Unsafe JSON path segment: ${segment}`);
	}
	return segment as JsonPathSegment;
}

/**
 * A scalar column projected from `raw`. `path` is the segment list into the QB
 * object, e.g. `['CustomerRef', 'value']` becomes `json_extract(raw,
 * '$.CustomerRef.value')`. `type` is the SQLite affinity: REAL for amounts,
 * INTEGER for JSON booleans (`json_extract` yields 0/1), TEXT otherwise. `name`
 * and `path` are validated at construction (see `col`), so both are branded.
 */
export type GeneratedColumn = {
	name: SqlIdent;
	type: ColumnType;
	path: JsonPathSegment[];
};

export type EntityDef = {
	/** QuickBooks entity name, e.g. `Invoice` (also the CDC `entities` value). */
	name: string;
	/** SQLite table name, e.g. `invoices`. Validated and branded by `entityDef`. */
	table: SqlIdent;
	columns: GeneratedColumn[];
};

export type QbObject = Record<string, unknown> & {
	Id?: string | number;
	status?: string;
	MetaData?: { LastUpdatedTime?: string; CreateTime?: string };
};

/** A column declaration: the SQLite name, its type, and the JSON path into `raw`. */
function col(
	name: string,
	type: ColumnType,
	...path: string[]
): GeneratedColumn {
	return { name: sqlIdent(name), type, path: path.map(jsonPathSegment) };
}

/**
 * The registry source, keyed by QB entity name (the canonical name). The `table`
 * is authored as a plain string here and branded when `entityDef` reads it out;
 * `columns` are already branded by `col`.
 */
type EntitySource = Omit<EntityDef, 'name' | 'table'> & { table: string };

/**
 * The default mirror set: every posting entity plus the name lists they
 * reference. Grouped by role for reading; the key order has no runtime meaning.
 * Extend or trim via `config.json` `entities`.
 */
export const ENTITY_DEFS = {
	// ── Name lists: what transactions reference by id. ──
	Account: {
		table: 'accounts',
		columns: [
			col('name', 'TEXT', 'Name'),
			col('account_type', 'TEXT', 'AccountType'),
			col('current_balance', 'REAL', 'CurrentBalance'),
			col('active', 'INTEGER', 'Active'),
		],
	},
	Customer: {
		table: 'customers',
		columns: [
			col('display_name', 'TEXT', 'DisplayName'),
			col('company_name', 'TEXT', 'CompanyName'),
			col('email', 'TEXT', 'PrimaryEmailAddr', 'Address'),
			col('active', 'INTEGER', 'Active'),
			col('balance', 'REAL', 'Balance'),
		],
	},
	Vendor: {
		table: 'vendors',
		columns: [
			col('display_name', 'TEXT', 'DisplayName'),
			col('company_name', 'TEXT', 'CompanyName'),
			col('active', 'INTEGER', 'Active'),
			col('balance', 'REAL', 'Balance'),
		],
	},
	Item: {
		table: 'items',
		columns: [
			col('name', 'TEXT', 'Name'),
			col('type', 'TEXT', 'Type'),
			col('unit_price', 'REAL', 'UnitPrice'),
			col('active', 'INTEGER', 'Active'),
		],
	},

	// ── Money in: accounts-receivable and cash sales. ──
	Invoice: {
		table: 'invoices',
		columns: [
			col('doc_number', 'TEXT', 'DocNumber'),
			col('doc_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('balance', 'REAL', 'Balance'),
			col('customer_ref', 'TEXT', 'CustomerRef', 'value'),
		],
	},
	Payment: {
		table: 'payments',
		columns: [
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('customer_ref', 'TEXT', 'CustomerRef', 'value'),
		],
	},
	// A cash / point-of-sale sale with no invoice: the money-in event an Invoice
	// never becomes. Line items live in `raw`.
	SalesReceipt: {
		table: 'sales_receipts',
		columns: [
			col('doc_number', 'TEXT', 'DocNumber'),
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('customer_ref', 'TEXT', 'CustomerRef', 'value'),
		],
	},
	// An A/R credit: reduces what a customer owes. `balance` is the credit not
	// yet applied to an invoice.
	CreditMemo: {
		table: 'credit_memos',
		columns: [
			col('doc_number', 'TEXT', 'DocNumber'),
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('balance', 'REAL', 'Balance'),
			col('customer_ref', 'TEXT', 'CustomerRef', 'value'),
		],
	},
	// Money refunded to a customer (the money-out counterpart of a sale).
	RefundReceipt: {
		table: 'refund_receipts',
		columns: [
			col('doc_number', 'TEXT', 'DocNumber'),
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('customer_ref', 'TEXT', 'CustomerRef', 'value'),
		],
	},
	// Money-in transactions (deposits, incl. posted bank-feed credits). The
	// crediting category lives in Line[].DepositLineDetail.AccountRef (1:N) and
	// stays in `raw`.
	Deposit: {
		table: 'deposits',
		columns: [
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('deposit_to', 'TEXT', 'DepositToAccountRef', 'name'),
		],
	},

	// ── Money out: accounts-payable and direct spend. ──
	Bill: {
		table: 'bills',
		columns: [
			col('doc_number', 'TEXT', 'DocNumber'),
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('balance', 'REAL', 'Balance'),
			col('vendor_ref', 'TEXT', 'VendorRef', 'value'),
		],
	},
	// Settles one or more Bills; the bills it pays live in Line[].LinkedTxn and
	// stay in `raw`. This is the money-out event a Bill (an obligation) is not.
	BillPayment: {
		table: 'bill_payments',
		columns: [
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('vendor_ref', 'TEXT', 'VendorRef', 'value'),
		],
	},
	// An A/P credit: reduces what you owe a vendor.
	VendorCredit: {
		table: 'vendor_credits',
		columns: [
			col('doc_number', 'TEXT', 'DocNumber'),
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('vendor_ref', 'TEXT', 'VendorRef', 'value'),
		],
	},
	// Money-out transactions (card/cash/check expenses, incl. posted bank-feed
	// items). The category lives in Line[].AccountBasedExpenseLineDetail.AccountRef
	// (1:N), so it stays in `raw`; the extracted columns are the header scalars
	// worth grouping and joining on.
	Purchase: {
		table: 'purchases',
		columns: [
			col('txn_date', 'TEXT', 'TxnDate'),
			col('total_amt', 'REAL', 'TotalAmt'),
			col('payment_type', 'TEXT', 'PaymentType'),
			col('account_ref', 'TEXT', 'AccountRef', 'name'),
			col('payee', 'TEXT', 'EntityRef', 'name'),
		],
	},

	// ── General ledger & banking. ──
	// Manual GL posting (adjustments, accruals). A JE has no header amount: the
	// debits and credits live per-line in Line[].JournalEntryLineDetail, so the
	// money stays in `raw` and only the document scalars are lifted. The honest
	// column-light case.
	JournalEntry: {
		table: 'journal_entries',
		columns: [
			col('doc_number', 'TEXT', 'DocNumber'),
			col('txn_date', 'TEXT', 'TxnDate'),
		],
	},
	// Bank-to-bank movement. The QB shape differs from the others: a single
	// `Amount` (not `TotalAmt`) and a From/To account pair.
	Transfer: {
		table: 'transfers',
		columns: [
			col('txn_date', 'TEXT', 'TxnDate'),
			col('amount', 'REAL', 'Amount'),
			col('from_account', 'TEXT', 'FromAccountRef', 'name'),
			col('to_account', 'TEXT', 'ToAccountRef', 'name'),
		],
	},
} satisfies Record<string, EntitySource>;

/** The default entities mirrored when config does not narrow the set. */
export const DEFAULT_ENTITIES: string[] = Object.keys(ENTITY_DEFS);

export function isKnownEntity(name: string): name is keyof typeof ENTITY_DEFS {
	return Object.hasOwn(ENTITY_DEFS, name);
}

export function entityDef(name: string): EntityDef {
	if (!isKnownEntity(name)) {
		throw new Error(
			`Unknown QuickBooks entity "${name}". Known entities: ${DEFAULT_ENTITIES.join(', ')}.`,
		);
	}
	const source = ENTITY_DEFS[name];
	return { name, table: sqlIdent(source.table), columns: source.columns };
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
