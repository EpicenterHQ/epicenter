/**
 * The host-runtime seam, written out in full.
 *
 * There is no host adapter interface, no registry, and no lifecycle object. The
 * whole integration is: the host owns the path, the schedule, the credentials
 * and the network; the mirror owns the shape, the gate, the write door and the
 * cursor. Everything below is host code, and none of it is in the library.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { booksMirror, type Purchase, type Vendor } from '../mirrors/books.ts';
import {
	defineMirror,
	type MirrorDeclaration,
	openMirrorReader,
	openMirrorWriter,
	path,
	type TableMap,
	table,
} from '../src/index.ts';

const directories: string[] = [];

function mirrorPath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'mirror-api-'));
	directories.push(directory);
	return join(directory, 'mirror.sqlite3');
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

// --- a fake authority the host talks to -------------------------------------

type Authority = {
	fullPull: (table: 'purchases' | 'vendors') => (Purchase | Vendor)[];
	changesSince: (cursor: string | null) => {
		changed: Record<string, unknown[]>;
		cursor: string;
	};
	readonly calls: string[];
};

function fakeAuthority(): Authority {
	const calls: string[] = [];
	const purchases: Purchase[] = [
		{
			Id: '1',
			MetaData: { LastUpdatedTime: '2026-07-01T00:00:00Z' },
			TotalAmt: 10,
			PaymentType: 'Cash',
		},
	];
	const vendors: Vendor[] = [
		{
			Id: 'v1',
			MetaData: { LastUpdatedTime: '2026-07-01T00:00:00Z' },
			DisplayName: 'AWS',
			Active: true,
		},
	];
	return {
		calls,
		fullPull(tableKey) {
			calls.push(`full:${tableKey}`);
			return tableKey === 'purchases' ? purchases : vendors;
		},
		changesSince(cursor) {
			calls.push(`cdc:${cursor ?? 'none'}`);
			return {
				changed: {
					purchases: [
						{
							Id: '1',
							MetaData: { LastUpdatedTime: '2026-07-02T00:00:00Z' },
							TotalAmt: 11,
							PaymentType: 'Cash',
						} satisfies Purchase,
					],
				},
				cursor: '2026-07-02T00:00:00Z',
			};
		},
	};
}

// --- the host's two roles ---------------------------------------------------

/**
 * The sync role. Backfill whatever has never been fully pulled, then run one
 * batched incremental pass that advances the single cursor in the same
 * transaction as the rows it accounts for (ADR-0064).
 */
function syncPass(
	declaration: MirrorDeclaration<TableMap>,
	file: string,
	authority: Authority,
): { rebuilt: boolean; backfilled: string[] } {
	using writer = openMirrorWriter(declaration, { path: file });
	const backfilled = [...writer.needsBackfill];
	for (const tableKey of backfilled) {
		writer.ingest(
			{ [tableKey]: authority.fullPull(tableKey as 'purchases') },
			{
				full: [tableKey],
			},
		);
	}
	const { changed, cursor } = authority.changesSince(writer.cursor);
	writer.ingest(changed, { cursor });
	return { rebuilt: writer.rebuilt, backfilled };
}

/** The serve role. Every outcome the host must render, and no other. */
function statusLine(
	declaration: MirrorDeclaration<TableMap>,
	file: string,
): string {
	const opened = openMirrorReader(declaration, { path: file });
	if (opened.status === 'absent') return 'no mirror yet; run a sync';
	if (opened.status === 'stale') {
		return `mirror was built by another release; run a sync (found ${opened.found ?? 'none'})`;
	}
	using reader = opened;
	const [row] = reader.query<{ n: number }>(
		'SELECT count(*) AS n FROM purchases',
	);
	return `caught up to ${reader.cursor}, ${row?.n ?? 0} purchases`;
}

describe('a host running both roles over one file', () => {
	test('the first pass backfills, later passes stay incremental', () => {
		const file = mirrorPath();
		const authority = fakeAuthority();

		expect(statusLine(booksMirror, file)).toBe('no mirror yet; run a sync');

		const first = syncPass(booksMirror, file, authority);
		expect(first.rebuilt).toBe(true);
		expect(first.backfilled.sort()).toEqual(['purchases', 'vendors']);
		expect(authority.calls).toEqual([
			'full:purchases',
			'full:vendors',
			'cdc:none',
		]);

		const second = syncPass(booksMirror, file, authority);
		expect(second.rebuilt).toBe(false);
		expect(second.backfilled).toEqual([]);
		expect(authority.calls.at(-1)).toBe('cdc:2026-07-02T00:00:00Z');

		expect(statusLine(booksMirror, file)).toBe(
			'caught up to 2026-07-02T00:00:00Z, 1 purchases',
		);
	});

	test('a shape change makes the next sync a full rebuild, with no operator step', () => {
		const file = mirrorPath();
		const authority = fakeAuthority();
		syncPass(booksMirror, file, authority);

		const withNewColumn = defineMirror({
			name: 'quickbooks',
			tables: {
				purchases: table<Purchase>({
					key: path('Id'),
					version: {
						from: path('MetaData', 'LastUpdatedTime'),
						order: 'lexical',
					},
					tombstone: path('status'),
					columns: {
						total: { type: 'real', from: path('TotalAmt') },
						paymentType: { type: 'text', from: path('PaymentType') },
						accountId: {
							type: 'text',
							from: path('AccountRef', 'value'),
							nullable: true,
						},
						accountName: {
							type: 'text',
							from: path('AccountRef', 'name'),
							nullable: true,
						},
						currency: {
							type: 'text',
							from: path('CurrencyRef', 'value'),
							nullable: true,
						},
					},
				}),
			},
		});

		// The serve role notices before the sync role runs, and says so instead of
		// serving rows shaped for the previous release.
		expect(statusLine(withNewColumn, file)).toContain('another release');

		authority.calls.length = 0;
		const rebuilt = syncPass(withNewColumn, file, authority);
		expect(rebuilt.rebuilt).toBe(true);
		// The host loop did not change, and it did not have to: `purchases`
		// retains raw, so the new column was filled from objects already on disk.
		// `vendors` left the declaration, so it is neither backfilled nor stranded.
		expect(rebuilt.backfilled).toEqual([]);
		expect(authority.calls).toEqual(['cdc:2026-07-02T00:00:00Z']);
		expect(statusLine(withNewColumn, file)).toContain('caught up to');
	});
});
