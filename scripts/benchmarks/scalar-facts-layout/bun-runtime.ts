/** Bun-owned SQLite lifecycle and physical page accounting for the benchmark. */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDatabase } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

export type PageMetrics = {
	allocatedPageBytes: number;
	nonFreelistPageBytes: number;
};

export type TempDatabase = {
	db: SqliteDatabase;
	close(): void;
	reopen(): SqliteDatabase;
	checkpoint(): void;
	pageMetrics(tables: string[]): PageMetrics;
	cleanup(): void;
};

export function openTempDatabase(statements: string[]): TempDatabase {
	const directory = mkdtempSync(join(tmpdir(), 'scalar-facts-layout-'));
	const path = join(directory, 'benchmark.db');
	let raw: Database | undefined;
	let current: SqliteDatabase | undefined;

	function open(): SqliteDatabase {
		if (raw) throw new Error('database is already open');
		raw = new Database(path);
		current = createBunSqliteAdapter(raw);
		current.run('PRAGMA journal_mode = WAL');
		current.run('PRAGMA foreign_keys = ON');
		return current;
	}

	function requireCurrent(): SqliteDatabase {
		if (!current) throw new Error('database is closed');
		return current;
	}

	let db: SqliteDatabase;
	try {
		db = open();
		for (const statement of statements) db.run(statement);
	} catch (error) {
		raw?.close();
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}

	return {
		db,
		close(): void {
			raw?.close();
			raw = undefined;
			current = undefined;
		},
		reopen: open,
		checkpoint(): void {
			requireCurrent().run('PRAGMA wal_checkpoint(TRUNCATE)');
		},
		pageMetrics(tables): PageMetrics {
			if (tables.length === 0) throw new Error('no candidate storage tables');
			const active = requireCurrent();
			const pageCount =
				active.all<{ page_count: number }>('PRAGMA page_count')[0]
					?.page_count ?? 0;
			const pageSize =
				active.all<{ page_size: number }>('PRAGMA page_size')[0]?.page_size ??
				0;
			const freelistCount =
				active.all<{ freelist_count: number }>('PRAGMA freelist_count')[0]
					?.freelist_count ?? 0;
			return {
				allocatedPageBytes: pageCount * pageSize,
				nonFreelistPageBytes: (pageCount - freelistCount) * pageSize,
			};
		},
		cleanup(): void {
			raw?.close();
			raw = undefined;
			current = undefined;
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
