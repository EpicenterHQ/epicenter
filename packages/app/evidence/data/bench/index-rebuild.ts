import { defineApp, defineTable, field, plainText } from '@epicenter/app';
/**
 * What ADR-0307's rebuild actually costs.
 *
 * Run: `bun run evidence/bench/index-rebuild.ts`
 *
 * ADR-0307 says a derived index is an in-memory SQLite database, invalidated
 * by any commit and rebuilt whole on the next read, and then makes that
 * conditional on one unmeasured number: "if a rebuild at the intended row
 * count exceeds roughly one second, this record is the wrong shape and should
 * be superseded rather than patched."
 *
 * The rebuild, exactly as the record writes it:
 *
 *     db = new Sqlite(':memory:');
 *     for (const row of table.rows) db.run('INSERT ...', row);
 *
 * METHOD:
 *   - The REAL store (`openMemory`), a notes-shaped table, and a content node
 *     written the way an editor writes it.
 *   - Seeding is outside every timed region.
 *   - The rebuild is split into the Y.Doc walk and the SQLite insert, then
 *     also run INTERLEAVED, which is what the record's loop does and the only
 *     number a first reader actually waits on.
 *   - Two indexes are measured, because they differ by more than noise:
 *       value    the row's fields only
 *       content  the fields plus `content.toString()`, which is what a
 *                full-text index over note bodies has to have
 *   - Untransacted insert is measured once per size as a control, not per
 *     run: `bun:sqlite` without a transaction pays an fsync-shaped cost per
 *     statement even in memory, and the difference is the point.
 *   - A LIVENESS control: every rebuild asserts the SQLite row count and the
 *     total body bytes it landed, so a run that silently indexed nothing
 *     reads as a failure rather than as a win.
 */

import { Database } from 'bun:sqlite';

import { InstantString } from '../../../src/data/field/index.js';
import { openMemory } from '../../../src/data/store/memory.js';

const definition = defineApp({
	id: 'so.epicenter.honeycrisp',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			pinned: field.boolean(),
			folderId: field.nullable(field.string()),
			deletedAt: field.nullable(field.string()),
			updatedAt: field.string(),
			content: plainText(),
		}),
	},
});

/** ~160 bytes, which is a short real note rather than a token. */
const BODY =
	'A note body of roughly a hundred and sixty bytes, which is what a short real one is, long enough that the string is not free to copy and not a token. ';

const SIZES = [10_000, 40_000];
const RUNS = 7;

type Store = Awaited<ReturnType<typeof openMemory<typeof definition>>>;

const SCHEMA = `create table notes (
	id text primary key,
	title text not null,
	pinned integer not null,
	folderId text,
	deletedAt text,
	updatedAt text not null,
	body text
)`;
const INSERT =
	'insert into notes (id, title, pinned, folderId, deletedAt, updatedAt, body) values (?, ?, ?, ?, ?, ?, ?)';

type Flat = [
	string,
	string,
	number,
	string | null,
	string | null,
	string,
	string | null,
];

/** The walk: every row out of the document, flattened to what SQLite takes. */
function walk(store: Store, withContent: boolean): Flat[] {
	const out: Flat[] = [];
	for (const row of store.tables.notes.rows) {
		out.push([
			row.id,
			row.title,
			row.pinned ? 1 : 0,
			row.folderId,
			row.deletedAt,
			row.updatedAt,
			withContent ? row.content.toString() : null,
		]);
	}
	return out;
}

function fresh(): Database {
	const db = new Database(':memory:');
	db.run(SCHEMA);
	return db;
}

function insertAll(db: Database, rows: Flat[], transacted: boolean): void {
	const statement = db.prepare(INSERT);
	if (!transacted) {
		for (const row of rows) statement.run(...row);
		return;
	}
	db.transaction(() => {
		for (const row of rows) statement.run(...row);
	})();
}

/** The record's own loop: no array in between, walk and insert interleaved. */
function rebuildInterleaved(store: Store, withContent: boolean): Database {
	const db = fresh();
	const statement = db.prepare(INSERT);
	db.transaction(() => {
		for (const row of store.tables.notes.rows) {
			statement.run(
				row.id,
				row.title,
				row.pinned ? 1 : 0,
				row.folderId,
				row.deletedAt,
				row.updatedAt,
				withContent ? row.content.toString() : null,
			);
		}
	})();
	return db;
}

function check(db: Database, size: number, withContent: boolean): void {
	const counted = db.query('select count(*) as n from notes').get() as {
		n: number;
	};
	if (counted.n !== size)
		throw new Error(`indexed ${counted.n} of ${size} rows`);
	const bytes = db.query('select sum(length(body)) as b from notes').get() as {
		b: number | null;
	};
	if (withContent) {
		if ((bytes.b ?? 0) < size * BODY.length)
			throw new Error(
				`indexed ${bytes.b} body bytes, expected the whole corpus`,
			);
	} else if (bytes.b !== null) {
		throw new Error('the value index carried bodies it was not given');
	}
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[middle] as number)
		: ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function span(values: number[]): string {
	return `${Math.min(...values).toFixed(0)}-${Math.max(...values).toFixed(0)}`;
}

function since(start: number): number {
	return (Bun.nanoseconds() - start) / 1e6;
}

console.log(`bun ${Bun.version}  ${process.platform}/${process.arch}`);
console.log(`${RUNS} runs per cell, medians in ms, range in brackets\n`);

for (const size of SIZES) {
	const store = await openMemory(definition);
	store.transact(() => {
		for (let i = 0; i < size; i += 1) {
			const row = store.tables.notes.create({
				title: `Note ${i}`,
				pinned: i % 11 === 0,
				folderId: i % 3 === 0 ? null : `folder-${i % 40}`,
				deletedAt: null,
				updatedAt: InstantString.now(),
			});
			row.content.insert(0, `${BODY}${i}`);
		}
	});
	if (store.tables.notes.ids().length !== size)
		throw new Error('the corpus did not build');

	// A floor for the walk: naming every row id touches the document and
	// conforms nothing, so the gap to `rows` is conformance and materialization
	// rather than Yjs traversal.
	const idRuns: number[] = [];
	for (let run = 0; run < RUNS; run += 1) {
		const start = Bun.nanoseconds();
		const ids = store.tables.notes.ids();
		idRuns.push(since(start));
		if (ids.length !== size) throw new Error('ids lost rows');
	}
	console.log(
		`${String(size).padStart(6)} ids() floor  | ${median(idRuns).toFixed(0)} ms [${span(idRuns)}]`,
	);

	for (const withContent of [false, true]) {
		const label = withContent ? 'fields + body' : 'fields only  ';
		const walks: number[] = [];
		const inserts: number[] = [];
		const totals: number[] = [];
		const interleaved: number[] = [];

		for (let run = 0; run < RUNS; run += 1) {
			const walkStart = Bun.nanoseconds();
			const rows = walk(store, withContent);
			walks.push(since(walkStart));
			if (rows.length !== size) throw new Error('the walk lost rows');

			const insertStart = Bun.nanoseconds();
			const db = fresh();
			insertAll(db, rows, true);
			inserts.push(since(insertStart));
			check(db, size, withContent);
			db.close();

			totals.push((walks.at(-1) as number) + (inserts.at(-1) as number));

			const wholeStart = Bun.nanoseconds();
			const live = rebuildInterleaved(store, withContent);
			interleaved.push(since(wholeStart));
			check(live, size, withContent);
			live.close();
		}

		// The control, once: the same insert with no transaction around it.
		const rows = walk(store, withContent);
		const loose = fresh();
		const looseStart = Bun.nanoseconds();
		insertAll(loose, rows, false);
		const untransacted = since(looseStart);
		check(loose, size, withContent);
		loose.close();

		console.log(
			`${String(size).padStart(6)} ${label}`,
			`| walk ${median(walks).toFixed(0).padStart(4)} ms [${span(walks)}]`,
			`insert ${median(inserts).toFixed(0).padStart(3)} ms [${span(inserts)}]`,
			`total ${median(totals).toFixed(0).padStart(4)} ms`,
			`| interleaved ${median(interleaved).toFixed(0).padStart(4)} ms [${span(interleaved)}]`,
			`| untransacted insert ${untransacted.toFixed(0)} ms`,
		);
	}

	await store[Symbol.asyncDispose]();
}
