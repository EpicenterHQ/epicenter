#!/usr/bin/env bun
/**
 * YJS vs SQLite Storage Benchmark
 *
 * A comprehensive, standalone benchmark comparing YJS and SQLite storage.
 *
 * Requirements:
 *   - Bun runtime (includes bun:sqlite)
 *   - workspace dependencies: `bun install` from the repository root
 *
 * Usage:
 *   bun run benchmark.ts
 *   bun run benchmark.ts 50000   # Custom record count
 *
 * What this measures:
 *   1. Bulk Insert: Store N identical records in both formats
 *   2. File Size: Compare storage efficiency
 *   3. Delete + Re-insert: Measure CRDT tombstone overhead
 *   4. Update Heavy: Repeated updates to existing records
 *   5. Read Performance: Query speed comparison
 *
 * Pattern used:
 *   This benchmark uses the factory function pattern. Instead of passing
 *   the database/document as the first argument to every function:
 *
 *     sqliteInsertAll(db, records)  // ❌ Anti-pattern
 *
 *   We create a factory that returns an object with methods:
 *
 *     const sqlite = createSqliteStore(path)
 *     sqlite.insertAll(records)     // ✅ Clean API
 *
 *   See: docs/articles/stop-passing-clients-as-arguments.md
 */

import { Database } from 'bun:sqlite';
import * as Y from '@y/y';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ============================================
// Configuration
// ============================================
const RECORD_COUNT = Number(process.argv[2]) || 100_000;
const OUTPUT_DIR = join(process.cwd(), '.yjs-benchmark');
const SQLITE_PATH = join(OUTPUT_DIR, 'benchmark.db');
const YJS_PATH = join(OUTPUT_DIR, 'benchmark.yjs');

// ============================================
// Types
// ============================================
type Record = {
	id: string;
	title: string;
	content: string;
	category: string;
	views: number;
	created_at: string;
	updated_at: string;
	is_published: number;
};

// ============================================
// Utilities
// ============================================
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMs(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function formatRate(count: number, ms: number): string {
	const rate = (count / ms) * 1000;
	if (rate >= 1_000_000) return `${(rate / 1_000_000).toFixed(1)}M/s`;
	if (rate >= 1000) return `${(rate / 1000).toFixed(1)}k/s`;
	return `${rate.toFixed(0)}/s`;
}

function cleanup() {
	if (existsSync(SQLITE_PATH)) rmSync(SQLITE_PATH);
	if (existsSync(SQLITE_PATH + '-wal')) rmSync(SQLITE_PATH + '-wal');
	if (existsSync(SQLITE_PATH + '-shm')) rmSync(SQLITE_PATH + '-shm');
	if (existsSync(YJS_PATH)) rmSync(YJS_PATH);
}

function getFileSize(path: string): number {
	if (!existsSync(path)) return 0;
	let size = statSync(path).size;
	if (existsSync(path + '-wal')) {
		size += statSync(path + '-wal').size;
	}
	return size;
}

function generateRecord(index: number): Record {
	const contentLength = 100 + (index % 400);
	const lorem =
		'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris ';

	return {
		id: `rec_${index.toString().padStart(8, '0')}`,
		title: `Record Title ${index}`,
		content: lorem.repeat(3).slice(0, contentLength),
		category: ['tech', 'science', 'art', 'music', 'sports'][index % 5],
		views: index * 10,
		created_at: `2024-01-${(index % 28 + 1).toString().padStart(2, '0')}T12:00:00Z`,
		updated_at: `2024-06-${(index % 28 + 1).toString().padStart(2, '0')}T12:00:00Z`,
		is_published: index % 3 === 0 ? 1 : 0,
	};
}

// ============================================
// SQLite Store (Factory Pattern)
// ============================================
/**
 * Creates a SQLite store with methods for CRUD operations.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                     FACTORY FUNCTION PATTERN                    │
 * ├─────────────────────────────────────────────────────────────────┤
 * │                                                                 │
 * │  BEFORE (anti-pattern):                                         │
 * │  ┌─────────────────────────────────────────────────────────┐   │
 * │  │ const db = createSqliteDb()                              │   │
 * │  │ sqliteInsertAll(db, records)  // db passed every time    │   │
 * │  │ sqliteDeleteAll(db)           // db passed every time    │   │
 * │  │ sqliteUpdateAll(db, records)  // db passed every time    │   │
 * │  └─────────────────────────────────────────────────────────┘   │
 * │                                                                 │
 * │  AFTER (factory pattern):                                       │
 * │  ┌─────────────────────────────────────────────────────────┐   │
 * │  │ const sqlite = createSqliteStore(path)                   │   │
 * │  │ sqlite.insertAll(records)     // db is closed over       │   │
 * │  │ sqlite.deleteAll()            // clean, no db argument   │   │
 * │  │ sqlite.updateAll(records)     // methods know their db   │   │
 * │  └─────────────────────────────────────────────────────────┘   │
 * │                                                                 │
 * └─────────────────────────────────────────────────────────────────┘
 */
function createSqliteStore(path: string) {
	const db = new Database(path);

	db.exec(`
		CREATE TABLE IF NOT EXISTS records (
			id TEXT PRIMARY KEY,
			title TEXT,
			content TEXT,
			category TEXT,
			views INTEGER,
			created_at TEXT,
			updated_at TEXT,
			is_published INTEGER
		)
	`);

	const insertStmt = db.prepare(`
		INSERT OR REPLACE INTO records (id, title, content, category, views, created_at, updated_at, is_published)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const updateStmt = db.prepare(`UPDATE records SET views = ?, updated_at = ? WHERE id = ?`);

	return {
		/** Insert all records in a single transaction. Returns time in ms. */
		insertAll(records: Record[]): number {
			const start = performance.now();
			const transaction = db.transaction(() => {
				for (const r of records) {
					insertStmt.run(r.id, r.title, r.content, r.category, r.views, r.created_at, r.updated_at, r.is_published);
				}
			});
			transaction();
			return performance.now() - start;
		},

		/** Delete all records. Returns time in ms. */
		deleteAll(): number {
			const start = performance.now();
			db.exec('DELETE FROM records');
			return performance.now() - start;
		},

		/** Update all records (increment views). Returns time in ms. */
		updateAll(records: Record[]): number {
			const start = performance.now();
			const transaction = db.transaction(() => {
				for (const r of records) {
					updateStmt.run(r.views + 1, new Date().toISOString(), r.id);
				}
			});
			transaction();
			return performance.now() - start;
		},

		/** Read all records. Returns time and count. */
		readAll(): { time: number; count: number } {
			const start = performance.now();
			const rows = db.query('SELECT * FROM records').all();
			return { time: performance.now() - start, count: rows.length };
		},

		/** Read records filtered by category. Returns time and count. */
		readByCategory(category: string): { time: number; count: number } {
			const start = performance.now();
			const rows = db.query('SELECT * FROM records WHERE category = ?').all(category);
			return { time: performance.now() - start, count: (rows as unknown[]).length };
		},

		/** Flush WAL and return current file size. */
		flush(): number {
			db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
			return getFileSize(path);
		},

		/** Close the database connection. */
		close() {
			db.close();
		},
	};
}

// ============================================
// YJS Store (Factory Pattern)
// ============================================
/**
 * Creates a YJS store with methods for CRUD operations.
 *
 * Same pattern as SQLite: the Y.Doc and Y.Node are closed over,
 * so callers don't need to pass them to every method.
 */
function createYjsStore() {
	const doc = new Y.Doc();
	const recordsMap = doc.get('records');

	return {
		/** Insert all records in a single transaction. Returns time in ms. */
		insertAll(records: Record[]): number {
			const start = performance.now();
			doc.transact(() => {
				for (const r of records) {
					const row = new Y.Node();
					row.setAttr('id', r.id);
					row.setAttr('title', r.title);
					row.setAttr('content', r.content);
					row.setAttr('category', r.category);
					row.setAttr('views', r.views);
					row.setAttr('created_at', r.created_at);
					row.setAttr('updated_at', r.updated_at);
					row.setAttr('is_published', r.is_published);
					recordsMap.setAttr(r.id, row);
				}
			});
			return performance.now() - start;
		},

		/** Delete all records. Returns time in ms. */
		deleteAll(): number {
			const start = performance.now();
			doc.transact(() => {
				for (const key of recordsMap.attrKeys()) {
					recordsMap.deleteAttr(key as string);
				}
			});
			return performance.now() - start;
		},

		/** Update all records (increment views). Returns time in ms. */
		updateAll(): number {
			const start = performance.now();
			doc.transact(() => {
				for (const [, row] of recordsMap.attrEntries()) {
					row.setAttr('views', (row.getAttr('views') as number) + 1);
					row.setAttr('updated_at', new Date().toISOString());
				}
			});
			return performance.now() - start;
		},

		/** Read all records. Returns time and count. */
		readAll(): { time: number; count: number } {
			const start = performance.now();
			const results: Record[] = [];
			for (const [, row] of recordsMap.attrEntries()) {
				results.push({
					id: row.getAttr('id') as string,
					title: row.getAttr('title') as string,
					content: row.getAttr('content') as string,
					category: row.getAttr('category') as string,
					views: row.getAttr('views') as number,
					created_at: row.getAttr('created_at') as string,
					updated_at: row.getAttr('updated_at') as string,
					is_published: row.getAttr('is_published') as number,
				});
			}
			return { time: performance.now() - start, count: results.length };
		},

		/** Read records filtered by category. Returns time and count. */
		readByCategory(category: string): { time: number; count: number } {
			const start = performance.now();
			const results: Record[] = [];
			for (const [, row] of recordsMap.attrEntries()) {
				if (row.getAttr('category') === category) {
					results.push({
						id: row.getAttr('id') as string,
						title: row.getAttr('title') as string,
						content: row.getAttr('content') as string,
						category: row.getAttr('category') as string,
						views: row.getAttr('views') as number,
						created_at: row.getAttr('created_at') as string,
						updated_at: row.getAttr('updated_at') as string,
						is_published: row.getAttr('is_published') as number,
					});
				}
			}
			return { time: performance.now() - start, count: results.length };
		},

		/** Save to file and return size. */
		async save(path: string): Promise<number> {
			const encoded = Y.encodeStateAsUpdate(doc);
			await Bun.write(path, encoded);
			return getFileSize(path);
		},

		/** Get current record count. */
		count(): number {
			return [...recordsMap.attrKeys()].length;
		},
	};
}

// ============================================
// Main Benchmark
// ============================================
async function runBenchmark() {
	console.log('');
	console.log('╔══════════════════════════════════════════════════════════════╗');
	console.log('║           YJS vs SQLite Storage Benchmark                    ║');
	console.log('╚══════════════════════════════════════════════════════════════╝');
	console.log('');
	console.log(`Records: ${RECORD_COUNT.toLocaleString()}`);
	console.log(`Output:  ${OUTPUT_DIR}`);
	console.log('');

	// Setup
	if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
	cleanup();

	// Generate data
	console.log('Generating test data...');
	const records: Record[] = [];
	for (let i = 0; i < RECORD_COUNT; i++) {
		records.push(generateRecord(i));
	}
	const jsonSize = records.reduce((sum, r) => sum + JSON.stringify(r).length, 0);
	console.log(`Raw JSON size: ${formatBytes(jsonSize)} (${(jsonSize / RECORD_COUNT).toFixed(0)} bytes/record avg)`);
	console.log('');

	// Results storage
	const results: {
		test: string;
		sqliteTime?: number;
		yjsTime?: number;
		sqliteSize?: number;
		yjsSize?: number;
	}[] = [];

	// ============================================
	// Create stores using factory pattern
	// ============================================
	const sqlite = createSqliteStore(SQLITE_PATH);
	const yjs = createYjsStore();

	// ============================================
	// TEST 1: Bulk Insert
	// ============================================
	console.log('─'.repeat(60));
	console.log('TEST 1: Bulk Insert');
	console.log('─'.repeat(60));

	const sqliteInsertTime = sqlite.insertAll(records);
	const sqliteInsertSize = sqlite.flush();

	const yjsInsertTime = yjs.insertAll(records);
	const yjsInsertSize = await yjs.save(YJS_PATH);

	console.log(`SQLite: ${formatMs(sqliteInsertTime)} | ${formatBytes(sqliteInsertSize)} | ${formatRate(RECORD_COUNT, sqliteInsertTime)}`);
	console.log(`YJS:    ${formatMs(yjsInsertTime)} | ${formatBytes(yjsInsertSize)} | ${formatRate(RECORD_COUNT, yjsInsertTime)}`);
	console.log(`Ratio:  YJS is ${(yjsInsertSize / sqliteInsertSize).toFixed(2)}x size of SQLite`);

	results.push({
		test: 'Bulk Insert',
		sqliteTime: sqliteInsertTime,
		yjsTime: yjsInsertTime,
		sqliteSize: sqliteInsertSize,
		yjsSize: yjsInsertSize,
	});
	console.log('');

	// ============================================
	// TEST 2: Read All
	// ============================================
	console.log('─'.repeat(60));
	console.log('TEST 2: Read All Records');
	console.log('─'.repeat(60));

	const sqliteReadResult = sqlite.readAll();
	const yjsReadResult = yjs.readAll();

	console.log(`SQLite: ${formatMs(sqliteReadResult.time)} | ${sqliteReadResult.count.toLocaleString()} records | ${formatRate(sqliteReadResult.count, sqliteReadResult.time)}`);
	console.log(`YJS:    ${formatMs(yjsReadResult.time)} | ${yjsReadResult.count.toLocaleString()} records | ${formatRate(yjsReadResult.count, yjsReadResult.time)}`);

	results.push({
		test: 'Read All',
		sqliteTime: sqliteReadResult.time,
		yjsTime: yjsReadResult.time,
	});
	console.log('');

	// ============================================
	// TEST 3: Filtered Read (by category)
	// ============================================
	console.log('─'.repeat(60));
	console.log('TEST 3: Filtered Read (category = "tech")');
	console.log('─'.repeat(60));

	const sqliteFilterResult = sqlite.readByCategory('tech');
	const yjsFilterResult = yjs.readByCategory('tech');

	console.log(`SQLite: ${formatMs(sqliteFilterResult.time)} | ${sqliteFilterResult.count.toLocaleString()} records`);
	console.log(`YJS:    ${formatMs(yjsFilterResult.time)} | ${yjsFilterResult.count.toLocaleString()} records`);

	results.push({
		test: 'Filtered Read',
		sqliteTime: sqliteFilterResult.time,
		yjsTime: yjsFilterResult.time,
	});
	console.log('');

	// ============================================
	// TEST 4: Update All Records
	// ============================================
	console.log('─'.repeat(60));
	console.log('TEST 4: Update All Records (increment views)');
	console.log('─'.repeat(60));

	const sqliteUpdateTime = sqlite.updateAll(records);
	const sqliteUpdateSize = sqlite.flush();

	const yjsUpdateTime = yjs.updateAll();
	const yjsUpdateSize = await yjs.save(YJS_PATH);

	console.log(`SQLite: ${formatMs(sqliteUpdateTime)} | ${formatBytes(sqliteUpdateSize)} | ${formatRate(RECORD_COUNT, sqliteUpdateTime)}`);
	console.log(`YJS:    ${formatMs(yjsUpdateTime)} | ${formatBytes(yjsUpdateSize)} | ${formatRate(RECORD_COUNT, yjsUpdateTime)}`);
	console.log(`Size change: SQLite ${formatBytes(sqliteUpdateSize - sqliteInsertSize)}, YJS +${formatBytes(yjsUpdateSize - yjsInsertSize)}`);

	results.push({
		test: 'Update All',
		sqliteTime: sqliteUpdateTime,
		yjsTime: yjsUpdateTime,
		sqliteSize: sqliteUpdateSize,
		yjsSize: yjsUpdateSize,
	});
	console.log('');

	// ============================================
	// TEST 5: Delete All + Re-insert (Tombstone test)
	// ============================================
	console.log('─'.repeat(60));
	console.log('TEST 5: Delete All + Re-insert (CRDT tombstone overhead)');
	console.log('─'.repeat(60));

	const sqliteDeleteTime = sqlite.deleteAll();
	const sqliteReinsertTime = sqlite.insertAll(records);
	const sqliteAfterReinsert = sqlite.flush();

	const yjsDeleteTime = yjs.deleteAll();
	const yjsReinsertTime = yjs.insertAll(records);
	const yjsAfterReinsert = await yjs.save(YJS_PATH);

	console.log(`SQLite delete:   ${formatMs(sqliteDeleteTime)}`);
	console.log(`SQLite reinsert: ${formatMs(sqliteReinsertTime)} | ${formatBytes(sqliteAfterReinsert)}`);
	console.log(`YJS delete:      ${formatMs(yjsDeleteTime)}`);
	console.log(`YJS reinsert:    ${formatMs(yjsReinsertTime)} | ${formatBytes(yjsAfterReinsert)}`);
	console.log('');
	console.log(`Tombstone overhead: YJS grew from ${formatBytes(yjsInsertSize)} to ${formatBytes(yjsAfterReinsert)}`);
	console.log(`                    That's ${((yjsAfterReinsert / yjsInsertSize - 1) * 100).toFixed(1)}% larger after delete+reinsert cycle`);

	results.push({
		test: 'After Delete+Reinsert',
		sqliteTime: sqliteDeleteTime + sqliteReinsertTime,
		yjsTime: yjsDeleteTime + yjsReinsertTime,
		sqliteSize: sqliteAfterReinsert,
		yjsSize: yjsAfterReinsert,
	});
	console.log('');

	// ============================================
	// TEST 6: Multiple Update Rounds
	// ============================================
	console.log('─'.repeat(60));
	console.log('TEST 6: Multiple Update Rounds (3 rounds of full updates)');
	console.log('─'.repeat(60));

	let sqliteTotalUpdateTime = 0;
	let yjsTotalUpdateTime = 0;

	for (let round = 1; round <= 3; round++) {
		sqliteTotalUpdateTime += sqlite.updateAll(records);
		yjsTotalUpdateTime += yjs.updateAll();
	}

	const sqliteFinalSize = sqlite.flush();
	const yjsFinalSize = await yjs.save(YJS_PATH);

	console.log(`SQLite: ${formatMs(sqliteTotalUpdateTime)} total | ${formatBytes(sqliteFinalSize)} final`);
	console.log(`YJS:    ${formatMs(yjsTotalUpdateTime)} total | ${formatBytes(yjsFinalSize)} final`);
	console.log(`YJS grew by ${formatBytes(yjsFinalSize - yjsAfterReinsert)} from update history`);

	results.push({
		test: 'After 3 Update Rounds',
		sqliteTime: sqliteTotalUpdateTime,
		yjsTime: yjsTotalUpdateTime,
		sqliteSize: sqliteFinalSize,
		yjsSize: yjsFinalSize,
	});
	console.log('');

	// Cleanup
	sqlite.close();

	// ============================================
	// Summary
	// ============================================
	console.log('╔══════════════════════════════════════════════════════════════╗');
	console.log('║                         SUMMARY                              ║');
	console.log('╚══════════════════════════════════════════════════════════════╝');
	console.log('');

	console.log('Storage Comparison:');
	console.log('┌─────────────────────────┬─────────────┬─────────────┬─────────┐');
	console.log('│ Stage                   │ SQLite      │ YJS         │ Ratio   │');
	console.log('├─────────────────────────┼─────────────┼─────────────┼─────────┤');

	for (const r of results) {
		if (r.sqliteSize && r.yjsSize) {
			const ratio = (r.yjsSize / r.sqliteSize).toFixed(2) + 'x';
			console.log(`│ ${r.test.padEnd(23)} │ ${formatBytes(r.sqliteSize).padStart(11)} │ ${formatBytes(r.yjsSize).padStart(11)} │ ${ratio.padStart(7)} │`);
		}
	}
	console.log('└─────────────────────────┴─────────────┴─────────────┴─────────┘');
	console.log('');

	const initialRatio = results[0].yjsSize! / results[0].sqliteSize!;
	const finalRatio = results[results.length - 1].yjsSize! / results[results.length - 1].sqliteSize!;

	console.log('Key Findings:');
	console.log(`  • Initial storage overhead: ${((initialRatio - 1) * 100).toFixed(1)}% larger than SQLite`);
	console.log(`  • After heavy operations:   ${((finalRatio - 1) * 100).toFixed(1)}% larger than SQLite`);
	console.log(`  • YJS provides: CRDT sync, offline-first, conflict resolution, undo/redo`);
	console.log('');

	console.log('Files saved to:');
	console.log(`  SQLite: ${SQLITE_PATH} (${formatBytes(sqliteFinalSize)})`);
	console.log(`  YJS:    ${YJS_PATH} (${formatBytes(yjsFinalSize)})`);
	console.log('');
}

// Run
runBenchmark().catch(console.error);
