/** Bun-owned SQLite lifecycle and physical page accounting for the benchmark. */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDatabase } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

/**
 * Machine-readable runtime identity for artifact reproducibility. Scoped to
 * page-addressable file SQLite (Bun here, browser OPFS later); a Durable Object
 * runner would report a different, discriminated shape.
 */
export type RuntimeDescription = {
	runtime: 'bun';
	bunVersion: string;
	sqliteVersion: string;
	os: { platform: string; release: string; arch: string };
	pragmas: {
		journalMode: string;
		synchronous: number;
		pageSize: number;
		recursiveTriggers: number;
		foreignKeys: number;
		ignoreCheckConstraints: number;
	};
};

/** Open a scratch temp database to read the exact runtime identity and pragmas. */
export function describeBunRuntime(): RuntimeDescription {
	const rt = openTempDatabase([]);
	try {
		const db = rt.db;
		return {
			runtime: 'bun',
			bunVersion: Bun.version,
			sqliteVersion:
				db.all<{ v: string }>('SELECT sqlite_version() AS v')[0]?.v ??
				'unknown',
			os: {
				platform: process.platform,
				release: release(),
				arch: process.arch,
			},
			pragmas: {
				journalMode:
					db.all<{ journal_mode: string }>('PRAGMA journal_mode')[0]
						?.journal_mode ?? 'unknown',
				synchronous:
					db.all<{ synchronous: number }>('PRAGMA synchronous')[0]
						?.synchronous ?? -1,
				pageSize:
					db.all<{ page_size: number }>('PRAGMA page_size')[0]?.page_size ?? -1,
				recursiveTriggers:
					db.all<{ recursive_triggers: number }>('PRAGMA recursive_triggers')[0]
						?.recursive_triggers ?? -1,
				foreignKeys:
					db.all<{ foreign_keys: number }>('PRAGMA foreign_keys')[0]
						?.foreign_keys ?? -1,
				ignoreCheckConstraints:
					db.all<{ ignore_check_constraints: number }>(
						'PRAGMA ignore_check_constraints',
					)[0]?.ignore_check_constraints ?? -1,
			},
		};
	} finally {
		rt.cleanup();
	}
}

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

/** A synchronous in-memory Bun database with the DDL applied; for constraint proofs. */
export function makeInMemoryBunDb(statements: string[]): SqliteDatabase {
	const db = createBunSqliteAdapter(new Database(':memory:'));
	db.run('PRAGMA foreign_keys = ON');
	for (const statement of statements) db.run(statement);
	return db;
}

/** An in-memory Bun database factory that pins the correctness-relevant pragmas. */
export function makeInMemoryBunDbWith(opts: {
	recursiveTriggers: boolean;
	foreignKeys: boolean;
	ignoreCheckConstraints: boolean;
}): (statements: string[]) => SqliteDatabase {
	return (statements) => {
		const db = createBunSqliteAdapter(new Database(':memory:'));
		db.run(
			`PRAGMA recursive_triggers = ${opts.recursiveTriggers ? 'ON' : 'OFF'}`,
		);
		db.run(`PRAGMA foreign_keys = ${opts.foreignKeys ? 'ON' : 'OFF'}`);
		db.run(
			`PRAGMA ignore_check_constraints = ${opts.ignoreCheckConstraints ? 'ON' : 'OFF'}`,
		);
		for (const statement of statements) db.run(statement);
		return db;
	};
}

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
