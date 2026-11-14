/**
 * `queryBooks` against a seeded mirror: the read-only path end to end (SQL ->
 * the SQLite mirror -> matching rows), and the read-only connection as the write
 * boundary. The API suite checks the row cap with more than 1000 rows.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { booksDbFile, openBooksDb } from '../db.ts';
import { queryBooks } from './query.ts';

/** Seed one company's mirror with two invoices (one soft-deleted). */
function fixtureMirror() {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-'));
	const mirror = booksDbFile(dir, 'realm-1');
	const db = openBooksDb(mirror);
	db.raw.exec(`
		CREATE TABLE invoices (
			id TEXT PRIMARY KEY, raw TEXT NOT NULL, updated_at TEXT,
			synced_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, total_amt REAL
		);
		INSERT INTO invoices (id, raw, synced_at, deleted, total_amt) VALUES
			('i1', '{"Id":"i1"}', '2026-01-01', 0, 100.0),
			('i2', '{"Id":"i2"}', '2026-01-01', 1, 50.0);
	`);
	db.close();
	return {
		mirror,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe('queryBooks', () => {
	test('runs a SELECT against the mirror and returns matching rows', () => {
		const { mirror, cleanup } = fixtureMirror();
		const data = expectOk(
			queryBooks({
				mirror,
				sql: 'SELECT id, total_amt FROM invoices WHERE deleted = 0',
			}),
		);

		expect(data).toMatchObject({ rowCount: 1, truncated: false });
		expect(data.rows).toEqual([{ id: 'i1', total_amt: 100 }]);
		cleanup();
	});

	test('rejects a write: the read-only connection is the boundary', () => {
		const { mirror, cleanup } = fixtureMirror();
		const error = expectErr(
			queryBooks({
				mirror,
				sql: "DELETE FROM invoices WHERE id = 'i1'",
			}),
		);

		expect(error.name).toBe('QueryFailed');
		const remaining = expectOk(
			queryBooks({ mirror, sql: "SELECT id FROM invoices WHERE id = 'i1'" }),
		);
		expect(remaining.rows).toEqual([{ id: 'i1' }]);
		cleanup();
	});

	test('errors clearly when no mirror exists yet', () => {
		const error = expectErr(
			queryBooks({
				mirror: booksDbFile(join(tmpdir(), 'local-books-absent'), 'realm'),
				sql: 'SELECT 1',
			}),
		);
		expect(error.message).toContain('No QuickBooks mirror');
	});
});
