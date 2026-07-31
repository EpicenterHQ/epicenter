/**
 * One declaration family, in the shapes the tests need: a baseline, the same
 * declaration with its object keys reordered, one with an added projection, one
 * with an added index, and one with a table added.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Authority, createAuthority } from '../src/authority.ts';
import type { MaterializationDeclaration } from '../src/declaration.ts';

export const DOMAIN = 'prototype.materialization.books/v1';

export const baseline: MaterializationDeclaration = {
	format: 1,
	domain: DOMAIN,
	row: { id: 'TEXT PRIMARY KEY', raw: 'TEXT NOT NULL', version: 'INTEGER' },
	tables: {
		purchase: {
			table: 'purchase',
			columns: [
				{ name: 'total', type: 'REAL', path: ['TotalAmt'] },
				{ name: 'txn_date', type: 'TEXT', path: ['TxnDate'] },
			],
		},
		vendor: {
			table: 'vendor',
			columns: [{ name: 'display_name', type: 'TEXT', path: ['DisplayName'] }],
		},
	},
};

/** Same facts, different literal key order and column key order. Must not rebuild. */
export const reordered: MaterializationDeclaration = {
	domain: DOMAIN,
	tables: {
		vendor: {
			columns: [{ path: ['DisplayName'], name: 'display_name', type: 'TEXT' }],
			table: 'vendor',
		},
		purchase: {
			columns: [
				{ type: 'REAL', path: ['TotalAmt'], name: 'total' },
				{ path: ['TxnDate'], type: 'TEXT', name: 'txn_date' },
			],
			table: 'purchase',
		},
	},
	row: { raw: 'TEXT NOT NULL', version: 'INTEGER', id: 'TEXT PRIMARY KEY' },
	format: 1,
};

/** An index only. Must not rebuild: an index holds no facts (ADR-0194). */
export const withIndex: MaterializationDeclaration = {
	...baseline,
	indexes: { 'purchase.txn_date': ['txn_date'] },
};

/** One table gains a projection. Only that table's stored shape moved. */
export const purchaseGainedColumn: MaterializationDeclaration = {
	...baseline,
	tables: {
		...baseline.tables,
		purchase: {
			table: 'purchase',
			columns: [
				{ name: 'total', type: 'REAL', path: ['TotalAmt'] },
				{ name: 'txn_date', type: 'TEXT', path: ['TxnDate'] },
				{ name: 'account_ref', type: 'TEXT', path: ['AccountRef', 'value'] },
			],
		},
	},
};

/** A new entity appears. Nothing existing moved. */
export const withNewTable: MaterializationDeclaration = {
	...baseline,
	tables: {
		...baseline.tables,
		bill: {
			table: 'bill',
			columns: [{ name: 'balance', type: 'REAL', path: ['Balance'] }],
		},
	},
};

/** The declaration serialization format itself changes: comparison is impossible. */
export const nextFormat = {
	...baseline,
	format: 2 as unknown as 1,
} satisfies MaterializationDeclaration;

export function seededAuthority(
	id: string,
	options?: { ordersRecords?: boolean },
): Authority {
	const authority = createAuthority(id, options);
	authority.push({
		id: 'p1',
		table: 'purchase',
		data: { TotalAmt: 42.5, TxnDate: '2026-07-01', AccountRef: { value: '7' } },
	});
	authority.push({ id: 'v1', table: 'vendor', data: { DisplayName: 'AWS' } });
	return authority;
}

export type Tmp = { dir: string; cleanup(): void };

export function tempRoot(prefix: string): Tmp {
	const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
