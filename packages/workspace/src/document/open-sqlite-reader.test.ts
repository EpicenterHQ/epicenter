/**
 * Tests for `openSqliteReader` (the script-side read-only handle on the
 * application's SQLite materializer file). The writer side is exercised via a real
 * `attachBunSqliteMaterializer` writing to an on-disk WAL file in a tmpdir;
 * the mirror reads the same file and asserts FTS5 lookups + raw row reads work.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { createWorkspace, defineTable } from '../index.js';
import { attachBunSqliteMaterializer } from './materializer/sqlite/bun-sqlite.js';
import { openSqliteReader } from './open-sqlite-reader.js';

const entriesTable = defineTable({
	id: field.string(),
	title: field.string(),
	body: field.string(),
});

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'open-sqlite-reader-'));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

async function seedMirrorFile(
	filePath: string,
	rows: Array<{ id: string; title: string; body: string }>,
	{ fts = true }: { fts?: boolean } = {},
) {
	using workspace = createWorkspace({
		id: 'test-mirror',
		tables: { entries: entriesTable },
		kv: {},
	});
	// debounceMs: 0 so each set() flushes on the next microtask, matching the
	// "seed then read" shape of these tests.
	const materializer = attachBunSqliteMaterializer(workspace, {
		filePath,
		debounceMs: 0,
		...(fts ? { fts: { entries: ['title', 'body'] } } : {}),
	});
	await materializer.whenFlushed;
	for (const row of rows) workspace.tables.entries.set({ ...row });
	// Yield once for the debounced flush, then once more for the awaited
	// syncQueue chain inside flushPendingSync to settle.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('openSqliteReader', () => {
	test('opens the file read-only and reads materialized rows', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirrorFile(filePath, [
			{ id: 'a', title: 'Alpha', body: 'first entry' },
			{ id: 'b', title: 'Beta', body: 'second entry' },
		]);

		using mirror = openSqliteReader({ filePath });
		const rows = mirror.db
			.prepare('SELECT id, title FROM entries ORDER BY id')
			.all() as Array<{ id: string; title: string }>;
		expect(rows).toEqual([
			{ id: 'a', title: 'Alpha' },
			{ id: 'b', title: 'Beta' },
		]);
	});

	test('rejects writes through the read-only handle', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirrorFile(filePath, [
			{ id: 'a', title: 'Alpha', body: 'first' },
		]);

		using mirror = openSqliteReader({ filePath });
		expect(() =>
			mirror.db.run(
				"INSERT INTO entries (id, title, body) VALUES ('c', 't', 'b')",
			),
		).toThrow();
	});

	test('search returns FTS5 hits with rank and snippet', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirrorFile(filePath, [
			{ id: 'a', title: 'Hello world', body: 'morning notes' },
			{ id: 'b', title: 'Goodbye', body: 'evening notes' },
			{ id: 'c', title: 'Hello again', body: 'morning followup' },
		]);

		using mirror = openSqliteReader({ filePath });
		const hits = mirror.search('entries', 'hello');
		const ids = hits.map((h) => h.id).sort();
		expect(ids).toEqual(['a', 'c']);
		for (const hit of hits) {
			expect(hit.snippet).toContain('Hello');
			expect(typeof hit.rank).toBe('number');
		}
	});

	test('search honors snippetColumn', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirrorFile(filePath, [
			{ id: 'a', title: 'Hello world', body: 'morning notes' },
		]);

		using mirror = openSqliteReader({ filePath });
		const hits = mirror.search('entries', 'morning', {
			snippetColumn: 'body',
		});
		const fallbackHits = mirror.search('entries', 'morning', {
			snippetColumn: 'missing',
		});

		expect(hits).toHaveLength(1);
		expect(hits[0]?.snippet).toContain('<mark>morning</mark>');
		expect(fallbackHits).toHaveLength(1);
		expect(fallbackHits[0]?.snippet).not.toContain('<mark>morning</mark>');
	});

	test('search returns empty array for missing FTS table', async () => {
		const filePath = join(workDir, 'empty.db');
		await seedMirrorFile(filePath, [], { fts: false });

		using mirror = openSqliteReader({ filePath });
		const hits = mirror.search('entries', 'anything');
		expect(hits).toEqual([]);
	});

	test('dispose closes the database handle', async () => {
		const filePath = join(workDir, 'mirror.db');
		await seedMirrorFile(filePath, [
			{ id: 'a', title: 'Alpha', body: 'first' },
		]);

		const mirror = openSqliteReader({ filePath });
		mirror[Symbol.dispose]();
		// Subsequent search short-circuits without throwing.
		const hits = mirror.search('entries', 'alpha');
		expect(hits).toEqual([]);
	});
});
