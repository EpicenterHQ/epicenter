/**
 * Native Inspection Tests
 *
 * Proves the inspection connection against a real Epicenter file and the real
 * SQLite that ships with Bun, because every guarantee here is a property of the
 * engine rather than of this code.
 *
 * Key behaviors:
 * - A read-only connection refuses every write but still installs TEMP views
 * - `SELECT * FROM notes` returns typed columns over live present rows
 * - Raw relations expose absent facts, unset values, and nonconforming payloads
 * - One submitted statement never runs a trailing statement
 * - Results are bounded by both row count and encoded size
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { field } from '@epicenter/field';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { openBunEpicenter } from './bun.js';
import {
	defineLens,
	defineTable,
	defineValue,
	optional,
} from './definitions.js';
import { createDesktopEpicenterOwner } from './desktop-owner.js';
import type { DesktopOperation } from './desktop-protocol.js';
import type { Epicenter } from './epicenter.js';
import {
	type InspectionRow,
	measureRowBytes,
	openInspection,
	readBounded,
} from './inspection.js';

const notesTable = defineTable({
	fields: {
		title: field.string(),
		pinned: field.boolean(),
		wordCount: optional(field.number()),
		tags: optional(field.tags()),
		metadata: optional(
			field.json(Type.Object({ score: Type.Number(), source: Type.String() })),
		),
	},
});

const lens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: { notes: notesTable },
	values: { theme: defineValue({ value: field.string() }) },
});

/** A second Lens over a different namespace, for the selection lifecycle. */
const otherLens = defineLens({
	namespace: 'so.epicenter.home',
	tables: { conversations: defineTable({ fields: { title: field.string() } }) },
	values: {},
});

let directory: string;
let path: string;
let epicenter: Epicenter;

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), 'inspection-'));
	path = join(directory, 'epicenter.sqlite3');
	epicenter = await openBunEpicenter({ path });
});

afterEach(async () => {
	await epicenter[Symbol.asyncDispose]();
	rmSync(directory, { recursive: true, force: true });
});

async function seed() {
	const data = epicenter.bind(lens);
	const first = await data.tables.notes.create({
		title: 'First',
		pinned: true,
	});
	const second = await data.tables.notes.create({
		title: 'Second',
		pinned: false,
		wordCount: 12,
	});
	await data.values.theme.set('dark');
	return { data, first, second };
}

test('a read-only connection refuses every write but still installs TEMP views', () => {
	const inspection = expectOk(openInspection({ path }));
	try {
		// The raw views exist, so TEMP object creation on a read-only main works.
		expectOk(inspection.query('SELECT * FROM _epicenter_rows'));

		for (const sql of [
			`INSERT INTO main._replica_v1_value_facts VALUES ('a.b','c','present','1',1)`,
			`UPDATE main._replica_v1_row_facts SET presence = 'absent'`,
			'DELETE FROM main._replica_v1_row_facts',
			'CREATE TABLE main.evil (a INTEGER)',
			'DROP TABLE main._replica_v1_row_facts',
			// A connection cannot even promote itself to a mode with looser rules.
			'PRAGMA journal_mode = WAL',
		]) {
			expect(expectErr(inspection.query(sql)).name).toBe('QueryFailed');
		}
	} finally {
		inspection.close();
	}
});

test('committed writer changes are visible to the next inspection statement', async () => {
	const { data } = await seed();
	const inspection = expectOk(openInspection({ path }));
	try {
		expectOk(inspection.selectLens(lens));
		expect(expectOk(inspection.query('SELECT * FROM notes')).rows).toHaveLength(
			2,
		);

		// A live write on the owner's own connection, after inspection opened.
		await data.tables.notes.create({ title: 'Third', pinned: false });

		const after = expectOk(
			inspection.query('SELECT title FROM notes ORDER BY title'),
		);
		expect(after.rows.map((row) => row.title)).toEqual([
			'First',
			'Second',
			'Third',
		]);
	} finally {
		inspection.close();
	}
});

describe('friendly Lens tables', () => {
	test('SELECT * FROM notes returns the declared columns over present rows', async () => {
		await seed();
		const inspection = expectOk(openInspection({ path }));
		try {
			expectOk(inspection.selectLens(lens));
			const result = expectOk(
				inspection.query('SELECT * FROM notes ORDER BY title'),
			);
			expect(result.rows).toHaveLength(2);
			// Explicit columns, not an opaque JSON blob.
			expect(Object.keys(result.rows[0] ?? {})).toEqual([
				'id',
				'title',
				'pinned',
				'wordCount',
				'tags',
				'metadata',
			]);
			expect(result.rows[0]?.title).toBe('First');
			// A boolean arrives as SQLite's 1/0, and an absent optional as NULL.
			expect(result.rows[0]?.pinned).toBe(1);
			expect(result.rows[0]?.wordCount).toBe(null);
			expect(result.rows[1]?.wordCount).toBe(12);
		} finally {
			inspection.close();
		}
	});

	test('ordinary SQL works: filters, aggregates, and expressions', async () => {
		await seed();
		const inspection = expectOk(openInspection({ path }));
		try {
			expectOk(inspection.selectLens(lens));
			expect(
				expectOk(
					inspection.query('SELECT COUNT(*) AS n FROM notes WHERE pinned = 1'),
				).rows,
			).toEqual([{ n: 1 }]);
			expect(
				expectOk(
					inspection.query(
						"SELECT upper(title) AS shout FROM notes WHERE title LIKE 'Sec%'",
					),
				).rows,
			).toEqual([{ shout: 'SECOND' }]);
		} finally {
			inspection.close();
		}
	});

	test('a deleted row leaves the friendly table but stays in the raw relation', async () => {
		const { data, first } = await seed();
		await data.tables.notes.delete(first.id);

		const inspection = expectOk(openInspection({ path }));
		try {
			expectOk(inspection.selectLens(lens));
			// `SELECT * FROM notes` answers "what are my notes"; a tombstone is not one.
			expect(
				expectOk(inspection.query('SELECT title FROM notes')).rows,
			).toEqual([{ title: 'Second' }]);

			// The tombstone is still inspectable, with absence stated as data.
			const raw = expectOk(
				inspection.query(
					`SELECT row_id, presence, fields_json FROM _epicenter_rows
					 WHERE presence = 'absent'`,
				),
			);
			expect(raw.rows).toEqual([
				{ row_id: first.id, presence: 'absent', fields_json: null },
			]);
		} finally {
			inspection.close();
		}
	});

	test('a nonconforming stored value remains visible while typed reads reject it', async () => {
		const { data, first } = await seed();
		// Write a number where the Lens declares text, behind the typed API.
		const writer = new Database(path);
		// Planted in both the local intent and the visible projection, because the
		// typed read folds intents while inspection reads the projection. A raw
		// writer cannot call the store's refresh, so it mirrors what that refresh
		// would have derived.
		writer.run(
			`UPDATE main._replica_v1_row_intents
			 SET set_fields = json_set(set_fields, '$.title', 42)
			 WHERE json_extract(set_fields, '$.title') = 'First'`,
		);
		writer.run(
			`UPDATE main._replica_v1_visible_rows
			 SET fields = json_set(fields, '$.title', 42)
			 WHERE json_extract(fields, '$.title') = 'First'`,
		);
		writer.close();

		const inspection = expectOk(openInspection({ path }));
		try {
			expectOk(inspection.selectLens(lens));
			const titles = expectOk(
				inspection.query('SELECT title FROM notes ORDER BY id'),
			).rows.map((row) => row.title);
			expect(titles).toContain(42);

			// Inspection names and extracts fields; only the typed Lens API certifies
			// that a row conforms and reports why this one does not.
			expect((await data.tables.notes.get(first.id)).error?.name).toBe(
				'NonconformingRow',
			);
		} finally {
			inspection.close();
		}
	});

	test('arrays and objects project as composable JSON text', async () => {
		const data = epicenter.bind(lens);
		await data.tables.notes.create({
			title: 'Structured',
			pinned: true,
			tags: ['local', 'important'],
			metadata: { score: 7, source: 'import' },
		});

		const inspection = expectOk(openInspection({ path }));
		try {
			expectOk(inspection.selectLens(lens));
			expect(
				expectOk(
					inspection.query(
						`SELECT json_each.value AS tag
						 FROM notes, json_each(notes.tags)
						 ORDER BY tag`,
					),
				).rows,
			).toEqual([{ tag: 'important' }, { tag: 'local' }]);
			expect(
				expectOk(
					inspection.query(
						`SELECT json_extract(metadata, '$.score') AS score
						 FROM notes`,
					),
				).rows,
			).toEqual([{ score: 7 }]);
		} finally {
			inspection.close();
		}
	});

	test('friendly NULL collapses missing and JSON null while raw JSON distinguishes them', async () => {
		await seed();
		const writer = new Database(path);
		writer.run(
			`UPDATE main._replica_v1_visible_rows
			 SET fields = json_set(fields, '$.wordCount', NULL)
			 WHERE json_extract(fields, '$.title') = 'Second'`,
		);
		writer.close();

		const inspection = expectOk(openInspection({ path }));
		try {
			expectOk(inspection.selectLens(lens));
			expect(
				expectOk(
					inspection.query('SELECT title, wordCount FROM notes ORDER BY title'),
				).rows,
			).toEqual([
				{ title: 'First', wordCount: null },
				{ title: 'Second', wordCount: null },
			]);
			expect(
				expectOk(
					inspection.query(
						`SELECT json_extract(fields_json, '$.title') AS title,
						        json_type(fields_json, '$.wordCount') AS stored_type
						 FROM _epicenter_rows
						 ORDER BY title`,
					),
				).rows,
			).toEqual([
				{ title: 'First', stored_type: null },
				{ title: 'Second', stored_type: 'null' },
			]);
		} finally {
			inspection.close();
		}
	});
});

describe('Lens selection lifecycle', () => {
	test('with no Lens selected the raw relations work and friendly tables do not', async () => {
		await seed();
		const inspection = expectOk(openInspection({ path }));
		try {
			expect(inspection.selectedNamespace).toBeUndefined();
			expect(
				expectOk(inspection.query('SELECT COUNT(*) AS n FROM _epicenter_rows'))
					.rows,
			).toEqual([{ n: 2 }]);
			expect(expectErr(inspection.query('SELECT * FROM notes')).name).toBe(
				'QueryFailed',
			);
		} finally {
			inspection.close();
		}
	});

	test('selecting another Lens replaces the previous friendly views', async () => {
		await seed();
		const inspection = expectOk(openInspection({ path }));
		try {
			expectOk(inspection.selectLens(lens));
			expect(inspection.mountedTables).toEqual(['notes']);

			expectOk(inspection.selectLens(otherLens));
			expect(inspection.selectedNamespace).toBe('so.epicenter.home');
			expect(inspection.mountedTables).toEqual(['conversations']);
			// The previous interpretation is gone rather than merged alongside.
			expect(expectErr(inspection.query('SELECT * FROM notes')).name).toBe(
				'QueryFailed',
			);
			expectOk(inspection.query('SELECT * FROM conversations'));
		} finally {
			inspection.close();
		}
	});

	test('clearing the Lens leaves the raw relations in place', async () => {
		await seed();
		const inspection = expectOk(openInspection({ path }));
		try {
			expectOk(inspection.selectLens(lens));
			expectOk(inspection.clearLens());
			expect(inspection.mountedTables).toEqual([]);
			expect(expectErr(inspection.query('SELECT * FROM notes')).name).toBe(
				'QueryFailed',
			);
			expectOk(inspection.query('SELECT * FROM _epicenter_rows'));
		} finally {
			inspection.close();
		}
	});
});

test('raw value relation exposes unset values as absent', async () => {
	const { data } = await seed();
	await data.values.theme.unset();

	const inspection = expectOk(openInspection({ path }));
	try {
		expect(
			expectOk(
				inspection.query(
					'SELECT namespace, value_name, presence, content_json FROM _epicenter_values',
				),
			).rows,
		).toEqual([
			{
				namespace: 'so.epicenter.honeycrisp',
				value_name: 'theme',
				presence: 'absent',
				content_json: null,
			},
		]);
	} finally {
		inspection.close();
	}
});

test('one submitted statement never runs a trailing statement', async () => {
	await seed();
	const inspection = expectOk(openInspection({ path }));
	try {
		// `prepare` compiles the first statement and ignores the rest. The write
		// would also be refused by the read-only connection, so the guarantee holds
		// on two independent grounds; this pins the first one.
		const result = expectOk(
			inspection.query(
				"SELECT 1 AS a; INSERT INTO main._replica_v1_value_facts VALUES ('a.b','c','present','1',1)",
			),
		);
		expect(result.rows).toEqual([{ a: 1 }]);
	} finally {
		inspection.close();
	}

	// Nothing was written by the ignored trailing statement. The seeded value is
	// unsettled local work, so it lives in the intent relations and the visible
	// projection; the fact relation holds authority truth and is still empty.
	const reader = new Database(path, { readonly: true });
	expect(
		reader
			.query<{ n: number }, []>(
				'SELECT COUNT(*) AS n FROM main._replica_v1_value_facts',
			)
			.get()?.n,
	).toBe(0);
	reader.close();
});

test('a TEMP view on the inspection connection cannot redirect the owner', async () => {
	const { data } = await seed();
	const inspection = expectOk(openInspection({ path }));
	try {
		expectOk(inspection.selectLens(lens));
		// The owner reads its own storage, unaffected by anything inspection mounted:
		// TEMP objects are connection-local, so this is structural, not a convention.
		const rows = await data.tables.notes.scan();
		expect(rows.rows).toHaveLength(2);
	} finally {
		inspection.close();
	}
});

describe('result bounds', () => {
	test('the row bound truncates and says so', async () => {
		const data = epicenter.bind(lens);
		for (let index = 0; index < 5; index += 1) {
			await data.tables.notes.create({ title: `n${index}`, pinned: false });
		}
		const inspection = expectOk(
			openInspection({
				path,
				bounds: { maxRows: 3, maxResultBytes: 8 * 1024 * 1024 },
			}),
		);
		try {
			const result = expectOk(
				inspection.query('SELECT * FROM _epicenter_rows'),
			);
			expect(result.rows).toHaveLength(3);
			expect(result.truncated).toBe(true);
		} finally {
			inspection.close();
		}
	});

	test('the byte bound truncates a small number of large rows', async () => {
		const data = epicenter.bind(lens);
		for (let index = 0; index < 4; index += 1) {
			await data.tables.notes.create({
				title: 'x'.repeat(4_000),
				pinned: false,
			});
		}
		const inspection = expectOk(
			openInspection({
				path,
				bounds: { maxRows: 1_000, maxResultBytes: 9_000 },
			}),
		);
		try {
			const result = expectOk(
				inspection.query('SELECT * FROM _epicenter_rows'),
			);
			expect(result.rows.length).toBeGreaterThan(0);
			expect(result.rows.length).toBeLessThan(4);
			expect(result.truncated).toBe(true);
		} finally {
			inspection.close();
		}
	});

	test('a result within both bounds is not marked truncated', async () => {
		await seed();
		const inspection = expectOk(openInspection({ path }));
		try {
			const result = expectOk(
				inspection.query('SELECT * FROM _epicenter_rows'),
			);
			expect(result.rows).toHaveLength(2);
			expect(result.truncated).toBe(false);
		} finally {
			inspection.close();
		}
	});
});

test('a closed connection refuses further statements', async () => {
	await seed();
	const inspection = expectOk(openInspection({ path }));
	inspection.close();
	expect(expectErr(inspection.query('SELECT 1')).name).toBe('Closed');
	// Closing twice is not an error; the caller owns the lifetime loosely.
	inspection.close();
});

describe('the application boundary', () => {
	test('inspection is not reachable through the desktop RPC surface', async () => {
		// ADR-0162: applications receive no SQL. They hold a message port into
		// `execute`, so the guarantee is that no operation kind reaches inspection.
		const owner = await createDesktopEpicenterOwner({ directory });
		try {
			await owner.execute({ surfaceId: 's', operation: { kind: 'open' } });
			for (const kind of ['inspect', 'query', 'sql', 'select-lens']) {
				// No operation kind carries SQL, so none can answer with result rows.
				const result = await owner.execute({
					surfaceId: 's',
					operation: { kind },
				});
				expect(result).not.toHaveProperty('rows');
			}

			// The type union enforces it rather than a runtime switch: an
			// inspection-shaped operation is not a `DesktopOperation` at all.
			const forbidden = {
				// @ts-expect-error applications receive no SQL operation (ADR-0162)
				kind: 'inspect',
				sql: 'SELECT * FROM notes',
			} satisfies DesktopOperation;
			expect(forbidden.kind).toBe('inspect');

			// The native host, holding the owner object, can inspect.
			const inspection = expectOk(owner.openInspection());
			expectOk(inspection.query('SELECT * FROM _epicenter_rows'));
			inspection.close();
		} finally {
			await owner[Symbol.asyncDispose]();
		}
	});
});

test('inspection reads a live store without any journal-mode change', async () => {
	// The refusal this pins: inspection does not need WAL. An ordinary
	// rollback-journal database serves a concurrent reader, because a writer only
	// holds an exclusive lock for the brief moment of a commit and the busy
	// timeout absorbs it. Switching the replica to WAL would change the shape of
	// the `.sqlite3` artifact for every consumer, which is far too much to spend
	// on a read-only console.
	const { data } = await seed();
	const reader = new Database(path, { readonly: true });
	expect(reader.query('PRAGMA journal_mode').get()).toEqual({
		journal_mode: 'delete',
	});
	reader.close();

	const inspection = expectOk(openInspection({ path }));
	try {
		expectOk(inspection.selectLens(lens));
		// Interleave owner writes and inspection reads on the one file.
		for (let index = 0; index < 5; index += 1) {
			await data.tables.notes.create({ title: `live${index}`, pinned: false });
			expect(
				expectOk(inspection.query('SELECT COUNT(*) AS n FROM notes')).rows,
			).toEqual([{ n: 3 + index }]);
		}
	} finally {
		inspection.close();
	}
});

describe('result bounds stop the work, not just the result', () => {
	/** Yield rows on demand, recording how many the reader actually pulled. */
	function counted(total: number) {
		const pulled = { count: 0 };
		function* rows(): Generator<Record<string, string | number | null>> {
			for (let index = 0; index < total; index += 1) {
				pulled.count += 1;
				yield { i: index };
			}
		}
		return { pulled, rows: rows() };
	}

	const wide = { maxRows: 10, maxResultBytes: 8 * 1024 * 1024 };

	test('exactly maxRows rows available is complete, not truncated', () => {
		const { pulled, rows } = counted(10);
		const result = readBounded(rows, wide);
		expect(result.rows).toHaveLength(10);
		expect(result.truncated).toBe(false);
		expect(pulled.count).toBe(10);
	});

	test('one row beyond maxRows costs exactly one extra pull', () => {
		// Knowing whether more exists requires asking once. It must not cost more.
		const { pulled, rows } = counted(1_000);
		const result = readBounded(rows, wide);
		expect(result.rows).toHaveLength(10);
		expect(result.truncated).toBe(true);
		expect(pulled.count).toBe(11);
	});

	test('the byte bound also stops pulling', () => {
		const { pulled, rows } = counted(1_000);
		const result = readBounded(rows, { maxRows: 1_000, maxResultBytes: 40 });
		expect(result.truncated).toBe(true);
		expect(result.rows.length).toBeLessThan(10);
		expect(pulled.count).toBe(result.rows.length + 1);
	});

	test('a huge result is never materialized', async () => {
		// The defect this pins: draining the statement first lets SQLite build the
		// entire result before either bound is consulted. Ten million rows take
		// about 1.5 seconds and over a gigabyte to materialize on this machine, and
		// well under a millisecond to step five rows from.
		await seed();
		const inspection = expectOk(
			openInspection({
				path,
				bounds: { maxRows: 5, maxResultBytes: 8 * 1024 * 1024 },
			}),
		);
		try {
			const started = Bun.nanoseconds();
			const result = expectOk(
				inspection.query(
					`WITH RECURSIVE g(i) AS (
						SELECT 1 UNION ALL SELECT i + 1 FROM g WHERE i < 10000000
					) SELECT i, 'padpadpadpadpadpadpadpad' AS p FROM g`,
				),
			);
			const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
			expect(result.rows).toHaveLength(5);
			expect(result.truncated).toBe(true);
			expect(elapsedMs).toBeLessThan(400);
		} finally {
			inspection.close();
		}
	});
});

describe('byte accounting covers every cell type', () => {
	test('each supported cell type is measured, and never as an empty object', () => {
		// A BLOB is the case that matters: `bun:sqlite` hands back a `Uint8Array`,
		// which `JSON.stringify` renders as an index-keyed object. Measuring its
		// `byteLength` would undercount the response about eightfold, and treating
		// it as `{}` would report almost nothing for an arbitrarily large payload.
		const blob = new Uint8Array(64);
		const measured = measureRowBytes({ b: blob });
		const rendered = new TextEncoder().encode(
			JSON.stringify({ b: blob }),
		).byteLength;
		expect(measured).toBeGreaterThanOrEqual(rendered);
		expect(measured).toBeGreaterThan(64);

		// An ArrayBuffer, which naive stringification renders as `{}`, is measured
		// by its length rather than by that rendering.
		expect(measureRowBytes({ b: new ArrayBuffer(64) })).toBeGreaterThan(64);

		// Text, numbers, and null are measured at least as large as they render.
		const rows: InspectionRow[] = [
			{ s: 'hello' },
			{ s: 'unicode: éèê' },
			{ n: 1234567 },
			{ n: -0.5 },
			{ x: null },
			{ a: 1, b: 'two', c: null },
		];
		for (const row of rows) {
			expect(measureRowBytes(row)).toBeGreaterThanOrEqual(
				new TextEncoder().encode(JSON.stringify(row)).byteLength,
			);
		}
	});

	test('a BLOB result is bounded by its rendered size, not its byte length', async () => {
		await seed();
		// 4 KiB of BLOB renders as roughly 36 KiB of JSON. A ceiling between the
		// two proves the bound follows the response rather than the payload.
		const inspection = expectOk(
			openInspection({ path, bounds: { maxRows: 100, maxResultBytes: 8_000 } }),
		);
		try {
			const result = expectOk(
				inspection.query('SELECT zeroblob(4096) AS b FROM _epicenter_rows'),
			);
			expect(result.rows).toHaveLength(0);
			expect(result.truncated).toBe(true);
		} finally {
			inspection.close();
		}
	});

	test('a BLOB small enough for the ceiling still comes back', async () => {
		await seed();
		const inspection = expectOk(openInspection({ path }));
		try {
			const result = expectOk(inspection.query('SELECT zeroblob(8) AS b'));
			expect(result.truncated).toBe(false);
			expect(result.rows).toHaveLength(1);
			expect(result.rows[0]?.b).toBeInstanceOf(Uint8Array);
		} finally {
			inspection.close();
		}
	});
});
