/**
 * SQL queries preserve collection projections, reread files, and bind values.
 * Reads refuse writes and statement tails, and close both SQLite databases.
 */
import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import {
	createMemoryContext,
	defineCollection,
	field,
	inRun,
	type QueryParams,
	query,
	queryTables,
} from './index.js';

const books = defineCollection({
	path: 'books/{slug}.md',
	fields: { title: field.text(), finished: field.date({ optional: true }) },
});
const settings = defineCollection({
	path: 'settings.md',
	fields: { goal: Type.Integer({ default: 5 }) },
});
const collections = { books, settings };
const book = '---\ntitle: "Dune"\n---\nRead it.\n';

// ============================================================================
// Projection and binding
// ============================================================================

test('singletons have zero rows when missing, while get still gives defaults; existing files use defaults', async () => {
	const context = createMemoryContext();
	await inRun(context, async () => {
		expect(await settings.get()).toMatchObject({ goal: 5 });
		const list = spyOn(context.folder, 'list');
		try {
			expect(await query({ settings }, 'select * from settings')).toEqual([]);
			expect(list).not.toHaveBeenCalled();
		} finally {
			list.mockRestore();
		}
		await context.folder.write('settings.md', 'My settings');
		expect(await query(collections, 'select * from settings')).toEqual([
			{
				path: 'settings.md',
				goal: 5,
				body: 'My settings',
				problems: null,
				other: null,
			},
		]);
	});
});

test('empty collections retain declared columns, in order, without reading files to describe them', async () => {
	const columns = queryTables(collections)[0]?.columns;
	expect(columns).toEqual(
		['path', 'slug', 'title', 'finished', 'body', 'problems', 'other'].map(
			(name) => ({
				name,
				type: ['problems', 'other'].includes(name) ? 'json' : 'text',
			}),
		),
	);
	await inRun(createMemoryContext(), async () => {
		expect(
			await query(
				collections,
				"select name, type from pragma_table_info('books')",
			),
		).toEqual((columns ?? []).map(({ name }) => ({ name, type: 'TEXT' })));
	});
});

test('path placeholders stay text and collections can be joined', async () => {
	const notes = defineCollection({
		path: 'notes/{year}/{time}.md',
		fields: { book: field.text() },
	});
	await inRun(
		createMemoryContext({
			'books/dune.md': book,
			'notes/2026/noon.md': '---\nbook: "dune"\n---\n',
		}),
		async () => {
			expect(
				await query(
					{ books, notes },
					'select n.year, typeof(n.year) as kind, n.time, b.title from notes n join books b on n.book = b.slug',
				),
			).toEqual([{ year: '2026', kind: 'text', time: 'noon', title: 'Dune' }]);
		},
	);
});

test('JSON fields, booleans, numeric kinds, absent fields, and select fields retain their SQL representations', async () => {
	const data = defineCollection({
		path: 'data/{id}.md',
		fields: {
			tags: field.tags(),
			meta: Type.Object({ author: Type.String() }),
			done: field.boolean(),
			count: field.integer(),
			score: field.number(),
			missing: field.text({ optional: true }),
			mode: field.select(['read', 'write']),
			anything: Type.Unknown(),
		},
	});
	expect(
		queryTables({ data })[0]
			?.columns.slice(2, 10)
			.map(({ type }) => type),
	).toEqual([
		'json',
		'json',
		'boolean',
		'integer',
		'real',
		'text',
		'text',
		'any',
	]);
	await inRun(
		createMemoryContext({
			'data/a.md':
				'---\ntags: ["a", "b"]\nmeta: {"author":"Sam"}\ndone: true\ncount: 2\nscore: 2.5\nmode: "read"\nanything: [1]\n---\n',
		}),
		async () => {
			expect(
				await query(
					{ data },
					"select j.value, json_extract(meta, '$.author') as author, done, typeof(done) as b, count, typeof(count) as i, score, typeof(score) as r, missing, mode from data, json_each(tags) j order by j.value",
				),
			).toEqual(
				['a', 'b'].map((value) => ({
					value,
					author: 'Sam',
					done: 1,
					b: 'integer',
					count: 2,
					i: 'integer',
					score: 2.5,
					r: 'real',
					missing: null,
					mode: 'read',
				})),
			);
		},
	);
});

test('handwritten reserved front matter stays in other and cannot overwrite file columns', async () => {
	const text =
		'---\ntitle: "Dune"\npath: "fake"\nslug: "fake"\nbody: "fake"\nproblems: ["fake"]\nother: {"fake":true}\n---\nReal body';
	await inRun(createMemoryContext({ 'books/dune.md': text }), async () => {
		const [row] = await query({ books }, 'select * from books');
		expect(row).toMatchObject({
			path: 'books/dune.md',
			slug: 'dune',
			body: 'Real body',
			title: 'Dune',
			problems: null,
		});
		expect(JSON.parse(String(row?.other))).toEqual({
			path: 'fake',
			slug: 'fake',
			body: 'fake',
			problems: ['fake'],
			other: { fake: true },
		});
	});
});

test('invalid, missing and unreadable front matter keep rows, defaults, problems and raw values', async () => {
	const data = defineCollection({
		path: 'data/{id}.md',
		fields: { count: field.integer(), goal: Type.Integer({ default: 5 }) },
	});
	await inRun(
		createMemoryContext({
			'data/bad.md': '---\ncount: "oops"\ngoal: "oops"\n---\n',
			'data/missing.md': 'Body',
			'data/unreadable.md': '---\n[unterminated\n---\nBody',
		}),
		async () => {
			const rows = await query({ data }, 'select * from data order by id');
			expect(rows).toHaveLength(3);
			expect(rows[0]).toMatchObject({ count: null, goal: 5 });
			expect(JSON.parse(String(rows[0]?.other))).toEqual({
				count: 'oops',
				goal: 'oops',
			});
			expect(JSON.parse(String(rows[0]?.problems))).toHaveLength(2);
			expect(String(rows[1]?.problems)).toContain('count is missing');
			expect(String(rows[2]?.problems)).toContain('front matter');
		},
	);
});

test('each call rereads files and positional and named bindings keep strings as values', async () => {
	const context = createMemoryContext({ 'books/dune.md': book });
	await inRun(context, async () => {
		expect(await query({ books }, 'select title from books')).toEqual([
			{ title: 'Dune' },
		]);
		await context.folder.write(
			'books/dune.md',
			book.replace('Dune', 'Changed'),
		);
		expect(await query({ books }, 'select title from books')).toEqual([
			{ title: 'Changed' },
		]);
		const injection = "'; drop table books; --";
		expect(
			await query({}, 'select ? as value, ? as flag', [injection, true]),
		).toEqual([{ value: injection, flag: 1 }]);
		for (const prefix of ['$', ':', '@'])
			expect(
				await query({}, `select ${prefix}value as value`, { value: false }),
			).toEqual([{ value: 0 }]);
	});
});

test('parameters need every value and preserve SQLite placeholder binding', async () => {
	await inRun(createMemoryContext(), async () => {
		const failures: [string, QueryParams?][] = [
			['select ? as value'],
			['select ? as value', []],
			['select ? as a, ? as b', [1]],
			['select ? as value', [1, 2]],
			['select $x, $y', { x: 1 }],
			['select $x as value', {}],
			['select ?1 as value', {}],
			['select ?2 as value', [1]],
			['select 1 as value', [1]],
			['select 1 as value', { x: 1 }],
		];
		for (const [sql, params] of failures)
			await expect(query({}, sql, params)).rejects.toMatchObject({
				name: 'Failed',
			});
		expect(await query({}, 'select ?1 as a, ?1 as b', [5])).toEqual([
			{ a: 5, b: 5 },
		]);
		expect(await query({}, 'select ?2 as value', [1, 2])).toEqual([
			{ value: 2 },
		]);
		expect(await query({}, 'select $x as a, $x as b', { x: 1 })).toEqual([
			{ a: 1, b: 1 },
		]);
		expect(await query({}, 'select :x as a, @y as b', { x: 1, y: 2 })).toEqual([
			{ a: 1, b: 2 },
		]);
		const value = "'; drop table books; --";
		expect(await query({}, 'select ? as value', [value])).toEqual([{ value }]);
	});
});

// ============================================================================
// Read-only boundary and lifecycle
// ============================================================================

test('write and connection commands are refused without changing files or creating external databases', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'epicenter-query-'));
	const attached = join(dir, 'attached.db');
	const vacuum = join(dir, 'vacuum.db');
	const context = createMemoryContext({ 'books/dune.md': book });
	const attempts = [
		"insert into books(path, slug, body) values ('x', 'x', '')",
		"update books set title = 'X'",
		'delete from books',
		"replace into books(path, slug, body) values ('x','x','')",
		"insert into books(path, slug, body) values ('x','x','') returning path",
		"with x as (select 1) insert into books(path, slug, body) values ('x','x','') returning path",
		'with x as (select 1) delete from books',
		'create table x(a)',
		'create temp table x(a)',
		'create temp view x as select 1',
		'create temp trigger x after insert on books begin select 1; end',
		'drop table books',
		'alter table books add column x',
		`attach '${attached}' as external`,
		'detach external',
		'vacuum',
		`vacuum into '${vacuum}'`,
		'begin',
		'commit',
		'savepoint x',
		'analyze',
		'reindex',
		'pragma query_only = 0',
		'pragma writable_schema = 1',
		'pragma soft_heap_limit = 1',
	];
	try {
		await inRun(context, async () => {
			for (const sql of attempts)
				await expect(query({ books }, sql)).rejects.toMatchObject({
					name: 'Refused',
				});
			await expect(
				query({ books }, "select load_extension('missing')"),
			).rejects.toMatchObject({ name: 'Failed' });
		});
		expect(await context.folder.list()).toEqual(['books/dune.md']);
		expect(await context.folder.read('books/dune.md')).toBe(book);
		await expect(access(attached)).rejects.toThrow();
		await expect(access(vacuum)).rejects.toThrow();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('the lexer refuses statement tails and allows quoted semicolons and comments', async () => {
	await inRun(createMemoryContext(), async () => {
		for (const sql of [
			'select 1; select 2',
			'select 1; drop table books',
			'select 1; /* hidden */ select 2',
			'-- only a comment',
			'',
			'; select 1',
		])
			await expect(query({}, sql)).rejects.toMatchObject({ name: 'Refused' });
		for (const sql of [
			'select 1 as n;',
			'select /* ; */ 1 as n',
			'with c(n) as (values(1)) select n from c',
			'/* start */ select 1 as n; -- end',
			'select 1 as n; /* unterminated',
			'-- start\nselect 1 as n;;;',
		])
			expect(await query({}, sql)).toEqual([{ n: 1 }]);
		for (const quote of ['"', '`'])
			expect(
				await query({}, `select ';' as ${quote}a;${quote}${quote}b${quote}`),
			).toEqual([{ [`a;${quote}b`]: ';' }]);
		expect(await query({}, "select 'it''s; fine' as [a;b]")).toEqual([
			{ 'a;b': "it's; fine" },
		]);
		expect(await query({}, 'values (1)')).toEqual([{ column1: 1 }]);
	});
});

test('duplicate result names and binary results are refused; SQL errors and missing parameters are Failed', async () => {
	await inRun(createMemoryContext(), async () => {
		for (const sql of ['select 1 as a, 2 as a', "select x'12' as bytes"])
			await expect(query({}, sql)).rejects.toMatchObject({ name: 'Refused' });
		for (const sql of ['select from', 'select ? as value'])
			await expect(query({}, sql)).rejects.toMatchObject({ name: 'Failed' });
	});
});

test('path is the only row identity, while an explicitly declared rowid is an ordinary field', async () => {
	const data = defineCollection({
		path: 'data/{id}.md',
		fields: { rowid: field.integer() },
	});
	await inRun(
		createMemoryContext({
			'books/dune.md': book,
			'data/a.md': '---\nrowid: 7\n---\n',
		}),
		async () => {
			for (const name of ['rowid', '_rowid_', 'oid'])
				await expect(
					query({ books }, `select ${name} from books`),
				).rejects.toMatchObject({ name: 'Failed' });
			expect(await query({ data }, 'select rowid from data')).toEqual([
				{ rowid: 7 },
			]);
		},
	);
});

test('SQLite column collisions name both columns and demand a rename for both entrypoints', async () => {
	for (const data of [
		defineCollection({
			path: 'data/{id}.md',
			fields: { title: field.text(), Title: field.text() },
		}),
		defineCollection({ path: 'data/{id}.md', fields: { Body: field.text() } }),
		defineCollection({ path: 'data/{pAth}.md', fields: {} }),
		defineCollection({ path: 'data/{id}.md', fields: { Id: field.text() } }),
	]) {
		expect(() => queryTables({ data })).toThrow(
			/collections.data.*columns.*rename one/,
		);
		await inRun(createMemoryContext(), async () => {
			await expect(query({ data }, 'select 1')).rejects.toThrow(
				/collections.data.*rename one/,
			);
		});
	}
});

test('local collections and matching local files never become tables or rows', async () => {
	const local = defineCollection({ path: 'token.local.md', fields: {} });
	const notes = defineCollection({ path: 'notes/{slug}.md', fields: {} });
	expect(queryTables({ notes, local }).map(({ table }) => table)).toEqual([
		'notes',
	]);
	await inRun(
		createMemoryContext({
			'token.local.md': 'secret',
			'notes/token.local.md': 'secret',
			'notes/ok.md': 'okay',
		}),
		async () => {
			expect(await query({ notes, local }, 'select slug from notes')).toEqual([
				{ slug: 'ok' },
			]);
			await expect(
				query({ notes, local }, 'select * from local'),
			).rejects.toMatchObject({ name: 'Failed' });
		},
	);
});

test('both databases close after success, SQLite failure, refusal, and bad binding', async () => {
	const close = spyOn(Database.prototype, 'close');
	const deserialize = spyOn(Database, 'deserialize');
	try {
		await inRun(createMemoryContext(), async () => {
			for (const [sql, params, outcome] of [
				['select 1 as value', undefined, 'success'],
				['select from', undefined, 'Failed'],
				['select 1 as a, 2 as a', undefined, 'Refused'],
				['select ? as value', [], 'Failed'],
			] as const) {
				const before = close.mock.calls.length;
				if (outcome === 'success')
					expect(await query({}, sql, params)).toEqual([{ value: 1 }]);
				else
					await expect(query({}, sql, params)).rejects.toMatchObject({
						name: outcome,
					});
				expect(close.mock.calls.length - before).toBe(2);
			}
		});
		expect(deserialize).toHaveBeenCalledTimes(4);
	} finally {
		close.mockRestore();
		deserialize.mockRestore();
	}
});

test('queries require a run even without any collections', async () => {
	await expect(query({}, 'select 1')).rejects.toThrow(
		"An app's collections and folder are read only inside an action's run",
	);
});

test('quoted table names work and a copied collection cannot pretend to own a record reader', async () => {
	await inRun(createMemoryContext({ 'books/dune.md': book }), async () => {
		expect(
			await query({ 'my-books': books }, 'select title from "my-books"'),
		).toEqual([{ title: 'Dune' }]);
		await expect(
			query({ books: { ...books } }, 'select * from books'),
		).rejects.toThrow('collections.books is not defineCollection(...)');
	});
});
