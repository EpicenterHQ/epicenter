/**
 * Invariants that hold with N writers on one file, in N processes, arriving in
 * any order. The mirror does not assume a single writer; it makes a stale write
 * physically unable to win.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { booksMirror, type Purchase } from '../mirrors/books.ts';
import { type MailMessage, mailMirror } from '../mirrors/mail.ts';
import {
	defineMirror,
	MirrorSupersededError,
	openMirrorReader,
	openMirrorWriter,
	path,
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

function purchase(updated: string, total: number, deleted = false): Purchase {
	return {
		Id: '1',
		MetaData: { LastUpdatedTime: updated },
		TotalAmt: total,
		PaymentType: 'Cash',
		...(deleted ? { status: 'Deleted' as const } : {}),
	};
}

function totals(file: string): unknown[] {
	const opened = openMirrorReader(booksMirror, { path: file });
	if (opened.status !== 'fresh') throw new Error(opened.status);
	using reader = opened;
	return reader.query('SELECT _version, _deleted, total FROM purchases');
}

describe('monotonicity: a stale write cannot win', () => {
	test('an older version cannot regress a newer row', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(booksMirror, { path: file });
		writer.ingest({ purchases: [purchase('2026-07-02T00:00:00Z', 200)] });
		const report = writer.ingest({
			purchases: [purchase('2026-07-01T00:00:00Z', 100)],
		});
		expect(report).toEqual({ applied: 0, rejectedStale: 1, tombstoned: 0 });
		expect(totals(file)).toEqual([
			{ _version: '2026-07-02T00:00:00Z', _deleted: 0, total: 200 },
		]);
	});

	test('an older live write cannot resurrect a tombstone', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(booksMirror, { path: file });
		writer.ingest({ purchases: [purchase('2026-07-01T00:00:00Z', 100)] });
		writer.ingest({ purchases: [purchase('2026-07-03T00:00:00Z', 100, true)] });
		// A retried fold-back from before the delete. Hard-deleting the row would
		// have lost the version that makes this rejection possible.
		const report = writer.ingest({
			purchases: [purchase('2026-07-02T00:00:00Z', 999)],
		});
		expect(report.rejectedStale).toBe(1);
		expect(totals(file)).toEqual([
			{ _version: '2026-07-03T00:00:00Z', _deleted: 1, total: null },
		]);
	});

	test('an older version cannot resurrect derived rows a newer version dropped', () => {
		const file = mirrorPath();
		const withAttachment = (historyId: number): MailMessage => ({
			id: 'm1',
			threadId: 't1',
			historyId,
			labelIds: ['INBOX'],
			internalDate: '1750000000000',
			payload: {
				mimeType: 'multipart/mixed',
				headers: [{ name: 'Subject', value: 'hi' }],
				parts: [
					{
						partId: '0',
						mimeType: 'application/pdf',
						filename: 'a.pdf',
						body: { attachmentId: 'att-a', size: 1 },
					},
				],
			},
		});
		const withoutAttachment = (historyId: number): MailMessage => ({
			...withAttachment(historyId),
			payload: {
				mimeType: 'text/plain',
				headers: [{ name: 'Subject', value: 'hi' }],
			},
		});

		using writer = openMirrorWriter(mailMirror, { path: file });
		writer.ingest({ messages: [withAttachment(100)] });
		writer.ingest({ messages: [withoutAttachment(200)] });
		const report = writer.ingest({ messages: [withAttachment(150)] });
		expect(report.rejectedStale).toBe(1);

		const opened = openMirrorReader(mailMirror, { path: file });
		if (opened.status !== 'fresh') throw new Error(opened.status);
		using reader = opened;
		// The derived set is a function of the winning source version. A rejected
		// parent must not leave children behind.
		expect(reader.query('SELECT count(*) AS n FROM attachments')).toEqual([
			{ n: 0 },
		]);
	});
});

describe('two writers, one file', () => {
	test('interleaved writers converge on the newest version, whatever the order', () => {
		const file = mirrorPath();
		using sync = openMirrorWriter(booksMirror, { path: file });
		using foldBack = openMirrorWriter(booksMirror, { path: file });

		// The write-back path commits the newer object first; the CDC pass then
		// arrives carrying the older snapshot it had already fetched.
		expect(foldBack.rebuilt).toBe(false);
		foldBack.ingest({ purchases: [purchase('2026-07-05T00:00:00Z', 500)] });
		const late = sync.ingest(
			{ purchases: [purchase('2026-07-04T00:00:00Z', 400)] },
			{ cursor: '2026-07-04T00:00:00Z' },
		);

		expect(late.rejectedStale).toBe(1);
		expect(totals(file)).toEqual([
			{ _version: '2026-07-05T00:00:00Z', _deleted: 0, total: 500 },
		]);
		// The cursor still advanced: it accounts for the window the pass covered,
		// not for whether each row happened to be the winner.
		expect(sync.cursor).toBe('2026-07-04T00:00:00Z');
	});

	test('a contended writer waits instead of failing instantly', () => {
		const file = mirrorPath();
		using a = openMirrorWriter(booksMirror, { path: file });
		using b = openMirrorWriter(booksMirror, { path: file });
		for (let index = 0; index < 50; index += 1) {
			const writer = index % 2 === 0 ? a : b;
			writer.ingest({
				purchases: [
					purchase(
						`2026-07-01T00:00:${String(index).padStart(2, '0')}Z`,
						index,
					),
				],
			});
		}
		expect(totals(file)).toEqual([
			{ _version: '2026-07-01T00:00:49Z', _deleted: 0, total: 49 },
		]);
	});
});

describe('stale state: a rebuild under an open handle', () => {
	const narrowed = defineMirror({
		name: 'quickbooks',
		tables: {
			purchases: table<Purchase>({
				key: path('Id'),
				version: {
					from: path('MetaData', 'LastUpdatedTime'),
					order: 'lexical',
				},
				tombstone: path('status'),
				columns: { total: { type: 'real', from: path('TotalAmt') } },
			}),
		},
	});

	test('a superseded writer refuses to write, and writes nothing', () => {
		const file = mirrorPath();
		using stale = openMirrorWriter(booksMirror, { path: file });
		stale.ingest({ purchases: [purchase('2026-07-01T00:00:00Z', 100)] });

		// Another process ships a new release and rebuilds the file underneath.
		{
			using fresh = openMirrorWriter(narrowed, { path: file });
			expect(fresh.rebuilt).toBe(true);
		}

		expect(() =>
			stale.ingest({ purchases: [purchase('2026-07-09T00:00:00Z', 900)] }),
		).toThrow(MirrorSupersededError);

		const opened = openMirrorReader(narrowed, { path: file });
		if (opened.status !== 'fresh') throw new Error(opened.status);
		using reader = opened;
		// The row the superseded writer tried to land is absent; the row the
		// rebuild reprojected from retained payloads is still there.
		expect(reader.query('SELECT _version, total FROM purchases')).toEqual([
			{ _version: '2026-07-01T00:00:00Z', total: 100 },
		]);
	});

	test('a reader that was fresh at open refuses to serve a rebuilt shape', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(booksMirror, { path: file });
			writer.ingest({ purchases: [purchase('2026-07-01T00:00:00Z', 100)] });
		}
		const opened = openMirrorReader(booksMirror, { path: file });
		if (opened.status !== 'fresh') throw new Error(opened.status);
		expect(opened.query('SELECT count(*) AS n FROM purchases')).toEqual([
			{ n: 1 },
		]);

		{
			using writer = openMirrorWriter(narrowed, { path: file });
			expect(writer.rebuilt).toBe(true);
		}

		// WAL hands out a snapshot per statement, not per connection, so "fresh at
		// open" is not a claim that survives on its own.
		expect(() => opened.query('SELECT count(*) AS n FROM purchases')).toThrow(
			MirrorSupersededError,
		);
	});
});
