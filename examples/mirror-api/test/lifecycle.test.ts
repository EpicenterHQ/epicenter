import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { booksMirror, type Purchase } from '../mirrors/books.ts';
import {
	defineMirror,
	describeMirror,
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

function purchase(id: string, updated: string, total: number): Purchase {
	return {
		Id: id,
		MetaData: { LastUpdatedTime: updated },
		TotalAmt: total,
		PaymentType: 'Cash',
		AccountRef: { value: '42', name: 'Software' },
	};
}

/** Same tables as `booksMirror` minus one column: a genuine shape change. */
const narrowedBooks = defineMirror({
	name: 'quickbooks',
	tables: {
		purchases: table<Purchase>({
			key: path('Id'),
			version: { from: path('MetaData', 'LastUpdatedTime'), order: 'lexical' },
			tombstone: path('status'),
			columns: { total: { type: 'real', from: path('TotalAmt') } },
		}),
	},
});

describe('describe is pure', () => {
	test('printing a schema opens nothing', () => {
		const file = mirrorPath();
		const text = describeMirror(booksMirror);
		expect(text).toContain('CREATE TABLE IF NOT EXISTS "purchases"');
		expect(text).toContain(booksMirror.fingerprint);
		expect(existsSync(file)).toBe(false);
	});
});

describe('open lifecycle', () => {
	test('a reader on a file that does not exist reports absent, not an error', () => {
		const opened = openMirrorReader(booksMirror, { path: mirrorPath() });
		expect(opened.status).toBe('absent');
	});

	test('the first writer builds the mirror and asks for a full pull', () => {
		using writer = openMirrorWriter(booksMirror, { path: mirrorPath() });
		expect(writer.rebuilt).toBe(true);
		expect(writer.cursor).toBeNull();
		expect([...writer.needsBackfill].sort()).toEqual(['purchases', 'vendors']);
	});

	test('a full pull latches the table and advances the one cursor', () => {
		const file = mirrorPath();
		using writer = openMirrorWriter(booksMirror, { path: file });
		writer.ingest(
			{ purchases: [purchase('1', '2026-07-01T00:00:00Z', 10)] },
			{ cursor: '2026-07-01T00:00:00Z', full: ['purchases'] },
		);
		expect(writer.cursor).toBe('2026-07-01T00:00:00Z');
		expect(writer.needsBackfill).toEqual(['vendors']);
	});

	test('a reader sees a fresh mirror and the writer cursor', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(booksMirror, { path: file });
			writer.ingest(
				{ purchases: [purchase('1', '2026-07-01T00:00:00Z', 10)] },
				{ cursor: 'c1', full: ['purchases'] },
			);
		}
		const opened = openMirrorReader(booksMirror, { path: file });
		expect(opened.status).toBe('fresh');
		if (opened.status !== 'fresh') return;
		using reader = opened;
		expect(reader.cursor).toBe('c1');
		expect(reader.query('SELECT total FROM purchases')).toEqual([
			{ total: 10 },
		]);
	});

	test('reopening with the same declaration keeps everything', () => {
		const file = mirrorPath();
		{
			using first = openMirrorWriter(booksMirror, { path: file });
			first.ingest(
				{ purchases: [purchase('1', '2026-07-01T00:00:00Z', 10)] },
				{ cursor: 'c1', full: ['purchases'] },
			);
		}
		using second = openMirrorWriter(booksMirror, { path: file });
		expect(second.rebuilt).toBe(false);
		expect(second.cursor).toBe('c1');
		expect(second.needsBackfill).toEqual(['vendors']);
	});
});

describe('the rebuild gate', () => {
	test('a reader whose declaration moved gets a status and no query surface', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(booksMirror, { path: file });
			writer.ingest({ purchases: [purchase('1', '2026-07-01T00:00:00Z', 10)] });
		}
		const opened = openMirrorReader(narrowedBooks, { path: file });
		expect(opened.status).toBe('stale');
		if (opened.status !== 'stale') return;
		expect(opened.expected).toBe(narrowedBooks.fingerprint);
		expect(opened.found).toBe(booksMirror.fingerprint);
		// There is nothing to call. Reading a shape you did not open is not a rule
		// a caller can break; it is a member that does not exist.
		expect('query' in opened).toBe(false);
	});

	test('a reader never repairs what it found stale', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(booksMirror, { path: file });
			writer.ingest({ purchases: [purchase('1', '2026-07-01T00:00:00Z', 10)] });
		}
		openMirrorReader(narrowedBooks, { path: file });
		const database = new Database(file, { readonly: true });
		const stamped = database
			.query<{ value: string }, []>(
				"SELECT value FROM _mirror WHERE key = 'fingerprint'",
			)
			.get();
		database.close(false);
		expect(stamped?.value).toBe(booksMirror.fingerprint);
	});

	test('a writer whose declaration moved drops every table the old one left behind', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(booksMirror, { path: file });
			writer.ingest(
				{ purchases: [purchase('1', '2026-07-01T00:00:00Z', 10)] },
				{ cursor: 'c1', full: ['purchases', 'vendors'] },
			);
		}
		using rebuilt = openMirrorWriter(narrowedBooks, { path: file });
		expect(rebuilt.rebuilt).toBe(true);
		// `purchases` retains raw, so the rebuild was local: rows, cursor and
		// latch all survived a shape change without touching the authority.
		expect(rebuilt.cursor).toBe('c1');
		expect(rebuilt.needsBackfill).toEqual([]);

		const database = new Database(file, { readonly: true });
		const names = database
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
		database.close(false);
		// `vendors` came from the previous declaration. Dropping only the tables
		// the *current* declaration names would have stranded it forever, and no
		// later fingerprint check could ever see it.
		expect(names).toEqual(['_mirror', 'purchases']);
	});

	test('rebuild: true is the escape hatch for a meaning change the gate cannot see', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(booksMirror, { path: file });
			writer.ingest(
				{ purchases: [purchase('1', '2026-07-01T00:00:00Z', 10)] },
				{ cursor: 'c1', full: ['purchases', 'vendors'] },
			);
		}
		using forced = openMirrorWriter(booksMirror, { path: file, rebuild: true });
		expect(forced.rebuilt).toBe(true);
		// On a raw-retaining mirror the escape hatch costs CPU and nothing else.
		expect(forced.cursor).toBe('c1');
		expect(forced.needsBackfill).toEqual([]);
	});
});

describe('indexes are reconciled, never fingerprinted', () => {
	const indexNames = (file: string) => {
		const database = new Database(file, { readonly: true });
		const names = database
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '_mirror_idx_%' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
		database.close(false);
		return names;
	};

	const withIndexes = (indexes: readonly (readonly string[])[]) =>
		defineMirror({
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
					indexes,
				}),
			},
		});

	test('an index survives a rebuild that reprojected its table', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(withIndexes([['total']]), { path: file });
			writer.ingest({ purchases: [purchase('1', '2026-07-01T00:00:00Z', 10)] });
		}
		// A shape change that keeps the same index name. The old index travels
		// with the renamed holding table, so a naive `CREATE INDEX IF NOT EXISTS`
		// would silently no-op and then vanish when the holding table is dropped.
		const widened = defineMirror({
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
					},
					indexes: [['total']],
				}),
			},
		});
		using rebuilt = openMirrorWriter(widened, { path: file });
		expect(rebuilt.rebuilt).toBe(true);
		expect(indexNames(file)).toEqual(['_mirror_idx_purchases__total']);

		const database = new Database(file, { readonly: true });
		const owner = database
			.query<{ tbl_name: string }, []>(
				"SELECT tbl_name FROM sqlite_master WHERE name = '_mirror_idx_purchases__total'",
			)
			.get();
		database.close(false);
		expect(owner?.tbl_name).toBe('purchases');
	});

	test('changing indexes preserves the cursor and the rows', () => {
		const file = mirrorPath();
		{
			using writer = openMirrorWriter(withIndexes([['total']]), { path: file });
			writer.ingest(
				{ purchases: [purchase('1', '2026-07-01T00:00:00Z', 10)] },
				{ cursor: 'c1', full: ['purchases'] },
			);
		}
		expect(indexNames(file)).toEqual(['_mirror_idx_purchases__total']);

		using changed = openMirrorWriter(withIndexes([]), { path: file });
		expect(changed.rebuilt).toBe(false);
		expect(changed.cursor).toBe('c1');
		expect(indexNames(file)).toEqual([]);
	});
});
