/**
 * Tests for `attachYjsLog` (the writer side of the SQLite
 * Yjs log pair). Covers: WAL pragma is applied to the file so
 * concurrent readers can open `{ readonly: true }` without `SQLITE_BUSY`,
 * and the basic load/replay/clear/dispose round-trip.
 *
 * Read-only consumer behavior is tested in
 * `attach-yjs-log-reader.test.ts`.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { attachYjsLog } from './attach-yjs-log.js';

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), 'attach-yjs-log-'));
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

function readJournalMode(filePath: string): string {
	const db = new Database(filePath, { readonly: true });
	try {
		const row = db.query('PRAGMA journal_mode').get() as {
			journal_mode: string;
		};
		return row.journal_mode;
	} finally {
		db.close();
	}
}

function countRows(filePath: string): number {
	const db = new Database(filePath, { readonly: true });
	try {
		const row = db.query('SELECT COUNT(*) as count FROM updates').get() as {
			count: number;
		};
		return row.count;
	} finally {
		db.close();
	}
}

// A lone 0x80 byte is an unterminated varint: the first readVarUint in
// applyUpdateV2 overruns the buffer, the same decode failure a half-written
// row produces.
const CORRUPT_BYTES = new Uint8Array([0x80]);

function appendCorruptRow(filePath: string): void {
	const db = new Database(filePath);
	try {
		db.query('INSERT INTO updates (data) VALUES (?)').run(CORRUPT_BYTES);
	} finally {
		db.close();
	}
}

function corruptEveryRow(filePath: string): void {
	const db = new Database(filePath);
	try {
		db.query('UPDATE updates SET data = ?').run(CORRUPT_BYTES);
	} finally {
		db.close();
	}
}

function firstRowData(filePath: string): Uint8Array {
	const db = new Database(filePath, { readonly: true });
	try {
		const row = db
			.query('SELECT data FROM updates ORDER BY id LIMIT 1')
			.get() as { data: Uint8Array };
		return row.data;
	} finally {
		db.close();
	}
}

describe('attachYjsLog', () => {
	test('writer enables WAL journal mode on the file', async () => {
		const filePath = join(workdir, 'wal.sqlite');
		const ydoc = new Y.Doc();
		const att = attachYjsLog(ydoc, { filePath });

		expect(readJournalMode(filePath).toLowerCase()).toBe('wal');

		ydoc.destroy();
		await att.whenDisposed;
	});

	test('round-trip: writer state survives close and reopen', async () => {
		const filePath = join(workdir, 'roundtrip.sqlite');

		const writerDoc = new Y.Doc();
		const writer = attachYjsLog(writerDoc, { filePath });
		writerDoc.transact(() => {
			const m = writerDoc.getMap<number>('m');
			for (let i = 0; i < 100; i++) m.set(`k${i}`, i);
		});
		writerDoc.destroy();
		await writer.whenDisposed;

		const reopenDoc = new Y.Doc();
		const reopen = attachYjsLog(reopenDoc, { filePath });
		const reopened = reopenDoc.getMap<number>('m');
		expect(reopened.size).toBe(100);
		expect(reopened.get('k0')).toBe(0);
		expect(reopened.get('k99')).toBe(99);
		reopenDoc.destroy();
		await reopen.whenDisposed;
	});

	test('destroy compacts multiple update rows into one snapshot row', async () => {
		const filePath = join(workdir, 'compact-on-destroy.sqlite');
		const writerDoc = new Y.Doc();
		const writer = attachYjsLog(writerDoc, { filePath });
		const map = writerDoc.getMap<number>('m');

		for (let i = 0; i < 5; i++) map.set(`k${i}`, i);

		expect(countRows(filePath)).toBeGreaterThan(1);

		writerDoc.destroy();
		await writer.whenDisposed;

		expect(countRows(filePath)).toBe(1);

		const reopenDoc = new Y.Doc();
		const reopen = attachYjsLog(reopenDoc, { filePath });
		expect(reopenDoc.getMap<number>('m').get('k4')).toBe(4);
		reopenDoc.destroy();
		await reopen.whenDisposed;
	});

	test('a corrupt row among good rows is skipped, data survives, and the log heals', async () => {
		const filePath = join(workdir, 'corrupt-among-good.sqlite');

		// Seed one clean compacted row with real content.
		const writerDoc = new Y.Doc();
		const writer = attachYjsLog(writerDoc, { filePath });
		writerDoc.getMap<number>('m').set('k', 42);
		writerDoc.destroy();
		await writer.whenDisposed;

		// Append a corrupt row after it. Pre-fix, replaying this row threw and
		// aborted construction (the owning application could not open the document).
		appendCorruptRow(filePath);
		expect(countRows(filePath)).toBe(2);

		// Cold reopen must NOT throw, and the good row's data must survive.
		const reopenDoc = new Y.Doc();
		const reopen = attachYjsLog(reopenDoc, { filePath });
		expect(reopenDoc.getMap<number>('m').get('k')).toBe(42);
		reopenDoc.destroy();
		await reopen.whenDisposed;

		// The skip triggered a compaction that dropped the corrupt row, so the
		// log is one clean snapshot and a third open is silent and correct.
		expect(countRows(filePath)).toBe(1);
		const thirdDoc = new Y.Doc();
		const third = attachYjsLog(thirdDoc, { filePath });
		expect(thirdDoc.getMap<number>('m').get('k')).toBe(42);
		thirdDoc.destroy();
		await third.whenDisposed;
	});

	test('a lone corrupt row is skipped and force-compacted into a clean snapshot', async () => {
		const filePath = join(workdir, 'lone-corrupt.sqlite');

		// Seed one clean row, then corrupt it so the whole log is undecodable.
		const writerDoc = new Y.Doc();
		const writer = attachYjsLog(writerDoc, { filePath });
		writerDoc.getMap<number>('m').set('k', 1);
		writerDoc.destroy();
		await writer.whenDisposed;
		corruptEveryRow(filePath);
		expect(countRows(filePath)).toBe(1);

		// Reopen: the single row is corrupt, so the doc hydrates empty. Without
		// the force flag the destroy-time compaction would no-op at <= 1 row and
		// leave the bad bytes; the skip-triggered force compaction must replace
		// them with a decodable empty-doc snapshot.
		const reopenDoc = new Y.Doc();
		const reopen = attachYjsLog(reopenDoc, { filePath });
		expect(reopenDoc.getMap<number>('m').size).toBe(0);
		reopenDoc.destroy();
		await reopen.whenDisposed;

		// The lone row is now a decodable snapshot, not the corrupt bytes.
		expect(countRows(filePath)).toBe(1);
		expect(() =>
			Y.applyUpdateV2(new Y.Doc(), firstRowData(filePath)),
		).not.toThrow();
	});
});
