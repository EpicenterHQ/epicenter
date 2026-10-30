/**
 * The SQL projection of a data folder, built through the two calls every
 * embedded SQLite binding has, so any engine builds the same tables.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	describeTables,
	type ProjectedTable,
	projectionProblem,
	projectTables,
	readingStatementProblem,
	type SqlTarget,
} from './projection.js';

/** `bun:sqlite` as the projection's target. */
const target = (db: Database): SqlTarget => ({
	run: (sql, parameters = []) => db.run(sql, [...parameters]),
	transaction: (run) => db.transaction(run)(),
});

const posts: ProjectedTable = {
	name: 'posts',
	fields: [
		{ name: 'title', schema: { type: 'string' } },
		{ name: 'order', schema: { type: 'number' } },
		{ name: 'pinned', schema: { type: 'boolean' } },
		{ name: 'tags', schema: { type: 'array', items: { type: 'string' } } },
		{
			name: 'due',
			schema: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
		},
	],
	rows: [
		{
			stem: 'reel',
			fields: { title: 'Reel', order: 1, pinned: true, tags: ['a'], due: null },
			body: 'Cut done.\n',
		},
	],
};

test('each table projects stem, its quoted fields, and body, as SQLite values', () => {
	const db = new Database(':memory:');
	projectTables(target(db), [posts]);
	expect(
		db
			.query('SELECT stem, title, "order", pinned, tags, due, body FROM posts')
			.all(),
	).toEqual([
		{
			stem: 'reel',
			title: 'Reel',
			order: 1,
			pinned: 1,
			tags: '["a"]',
			due: null,
			body: 'Cut done.\n',
		},
	]);
	expect(() => db.run(`DELETE FROM posts`)).toThrow();
});

test('a table that cannot be one SQLite table is named, not projected', () => {
	const clash = (name: string): ProjectedTable => ({
		name: 'notes',
		fields: [
			{ name: 'Title', schema: {} },
			{ name, schema: {} },
		],
		rows: [],
	});
	expect(projectionProblem(clash('title'))).toBe(
		"table 'notes' declares 'Title' and 'title', which differ only by case",
	);
	expect(projectionProblem(clash('Body'))).toBe(
		"table 'notes' declares a field 'Body', but query uses 'body' for the row itself",
	);
	expect(projectionProblem(posts)).toBeUndefined();
	expect(() =>
		projectTables(target(new Database(':memory:')), [clash('stem')]),
	).toThrow("uses 'stem' for the row itself");
});

test('only a statement that starts with a reading keyword may run', () => {
	expect(readingStatementProblem('-- why\n select 1')).toBeUndefined();
	expect(
		readingStatementProblem('WITH t AS (SELECT 1) SELECT * FROM t'),
	).toBeUndefined();
	expect(readingStatementProblem("ATTACH 'x.db' AS x")).toContain('not ATTACH');
	expect(readingStatementProblem(' /* nothing */ ')).toContain('empty');
});

test('the description names what each column holds', () => {
	expect(
		describeTables([posts])[0]?.columns.map(({ values }) => values),
	).toEqual([
		"the row's file is posts/<stem>.md",
		'string',
		'number',
		'boolean',
		'list of string',
		'date|null',
		'Markdown after the frontmatter',
	]);
});
