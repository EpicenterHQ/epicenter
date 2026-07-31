/**
 * The rebuild gate, and the split that makes it safe: writers rebuild, readers
 * never do.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { defineMirror, type MirrorDeclaration } from './declaration.ts';
import { openMirrorReader } from './reader.ts';
import { openMirrorWriter } from './writer.ts';

const v1: MirrorDeclaration = {
	domain: 'test.mirror',
	tables: {
		invoices: {
			columns: { total_amt: { type: 'REAL', from: ['TotalAmt'] } },
			orderBy: { column: 'updated_at', from: ['MetaData', 'LastUpdatedTime'] },
			softDelete: true,
		},
	},
};

function seeded(database: ReturnType<typeof createBunSqliteAdapter>) {
	const writer = openMirrorWriter(defineMirror(v1), { database });
	writer.write({ syncedAt: 'p1' }, ({ table, advance }) => {
		table('invoices').upsert({
			id: '1',
			record: { TotalAmt: 100, MetaData: { LastUpdatedTime: 'u1' } },
		});
		advance({ cursor: 'c1', lastFullPullAt: 'p1', lastSyncedAt: 'p1' });
	});
	return writer;
}

describe('the writer owns the rebuild', () => {
	test('a matching declaration is reused and touches nothing', () => {
		const database = createBunSqliteAdapter(new Database(':memory:'));
		seeded(database);

		const reopened = openMirrorWriter(defineMirror(v1), { database });

		expect(reopened.opened).toBe('reused');
		expect(reopened.count('invoices')).toBe(1);
		expect(reopened.state().cursor).toBe('c1');
	});

	test('a changed declaration drops the derived tables and clears the cursor', () => {
		const database = createBunSqliteAdapter(new Database(':memory:'));
		seeded(database);
		// An app-owned `_meta` key, to prove the gate clears the pull cursor and
		// not the whole namespace.
		database.run(
			`INSERT INTO _meta (key, value) VALUES ('app_note', 'keep me')`,
		);

		const rebuilt = openMirrorWriter(
			defineMirror({
				...v1,
				tables: {
					invoices: {
						...v1.tables.invoices,
						columns: {
							total_amt: { type: 'REAL', from: ['TotalAmt'] },
							doc_number: { type: 'TEXT', from: ['DocNumber'] },
						},
					},
				},
			}),
			{ database },
		);

		expect(rebuilt.opened).toBe('rebuilt');
		expect(rebuilt.exists('invoices')).toBe(false);
		expect(rebuilt.state()).toEqual({
			cursor: null,
			lastFullPullAt: null,
			lastSyncedAt: null,
		});
		expect(
			database.all<{ value: string }>(
				`SELECT value FROM _meta WHERE key = 'app_note'`,
			)[0]?.value,
		).toBe('keep me');
	});

	test('adding an index is not a rebuild, so a query optimization costs no re-pull', () => {
		const database = createBunSqliteAdapter(new Database(':memory:'));
		seeded(database);

		const reopened = openMirrorWriter(
			defineMirror({
				...v1,
				tables: {
					invoices: {
						...v1.tables.invoices,
						indexes: { idx_invoices_total: ['total_amt'] },
					},
				},
			}),
			{ database },
		);

		expect(reopened.opened).toBe('reused');
		expect(reopened.count('invoices')).toBe(1);
		expect(reopened.state().cursor).toBe('c1');
	});

	test("restamping a supplied column's derivation forces the rebuild", () => {
		const database = createBunSqliteAdapter(new Database(':memory:'));
		const declare = (revision: string) =>
			defineMirror({
				domain: 'test.mirror',
				tables: {
					messages: { supplied: { body: { type: 'TEXT', revision } } },
				},
			});

		openMirrorWriter(declare('v1'), { database }).write(
			{ syncedAt: 'p1' },
			({ table }) => {
				table('messages').upsert({
					id: '1',
					record: { any: 'thing' },
					supplied: { body: 'old parse' },
				});
			},
		);

		expect(openMirrorWriter(declare('v2'), { database }).opened).toBe(
			'rebuilt',
		);
	});
});

describe('the reader never rebuilds', () => {
	const directories: string[] = [];
	afterEach(() => {
		for (const directory of directories) {
			rmSync(directory, { recursive: true, force: true });
		}
		directories.length = 0;
	});

	function mirrorFile(): string {
		const directory = mkdtempSync(join(tmpdir(), 'mirror-api-'));
		directories.push(directory);
		return join(directory, 'mirror.db');
	}

	test('a stale mirror is reported, not repaired', () => {
		const path = mirrorFile();
		const written = new Database(path, { create: true });
		seeded(createBunSqliteAdapter(written));
		written.close();

		const reading = new Database(path, { readonly: true });
		const reader = openMirrorReader(
			defineMirror({
				...v1,
				tables: {
					invoices: {
						...v1.tables.invoices,
						columns: { total_amt: { type: 'TEXT', from: ['TotalAmt'] } },
					},
				},
			}),
			{ database: createBunSqliteAdapter(reading) },
		);

		expect(reader.stale).toBe(true);
		expect(reader.storedDeclaration).toContain('"total_amt"');
		// Everything the writer left is still there: no drop, no restamp.
		expect(reader.count('invoices')).toBe(1);
		expect(reader.state().cursor).toBe('c1');
		reading.close();

		// And SQLite agrees the handle cannot write, so the refusal is not just a
		// missing method on this object. Note where the backstop actually lands:
		// opening a writer over a read-only connection succeeds when the
		// declaration already matches, because every statement on that path is a
		// read or a no-op `CREATE TABLE IF NOT EXISTS`. The engine refuses at the
		// first real write. The capability split is what keeps a reader from
		// getting here; SQLite is the second line, not the first.
		const enforced = new Database(path, { readonly: true });
		const overReadOnly = openMirrorWriter(defineMirror(v1), {
			database: createBunSqliteAdapter(enforced),
		});
		expect(() =>
			overReadOnly.write({ syncedAt: 'p2' }, ({ table }) => {
				table('invoices').upsert({ id: '2', record: { TotalAmt: 1 } });
			}),
		).toThrow();
		enforced.close();
	});

	test('a current mirror reads as current', () => {
		const path = mirrorFile();
		const written = new Database(path, { create: true });
		seeded(createBunSqliteAdapter(written));
		written.close();

		const reading = new Database(path, { readonly: true });
		const reader = openMirrorReader(defineMirror(v1), {
			database: createBunSqliteAdapter(reading),
		});

		expect(reader.stale).toBe(false);
		expect(reader.count('invoices')).toBe(1);
		reading.close();
	});

	test('a mirror nobody has written yet is empty, not an error', () => {
		const database = createBunSqliteAdapter(new Database(':memory:'));
		const reader = openMirrorReader(defineMirror(v1), { database });

		expect(reader.stale).toBe(true);
		expect(reader.storedDeclaration).toBe(null);
		expect(reader.exists('invoices')).toBe(false);
		expect(reader.count('invoices')).toBe(0);
		expect(reader.state()).toEqual({
			cursor: null,
			lastFullPullAt: null,
			lastSyncedAt: null,
		});
	});
});
