import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { loadPath } from '../load/fs';
import { classifyRows } from './conformance';
import { validateContract } from './contract';
import type { Row } from './parse';
import { projectToSqlite } from './sqlite';

/** Resolve the bundled example vault by walking up from this file until it appears, so the path holds
 *  wherever in the repo this test lives, not at a fixed offset from `import.meta.dir`. */
function findExampleVault(): string {
	let dir = import.meta.dir;
	for (;;) {
		const candidate = resolve(dir, 'examples/matter/content-vault');
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir)
			throw new Error('examples/matter/content-vault not found');
		dir = parent;
	}
}

function contract(
	fields: Record<string, Record<string, unknown>>,
	optional?: string[],
) {
	return expectOk(validateContract({ fields, optional }));
}

const m = contract({
	title: { type: 'string' },
	status: { type: 'string', enum: ['draft', 'published'] },
	count: { type: 'integer' },
	score: { type: 'number' },
	live: { type: 'boolean' },
	tags: { type: 'array', items: { type: 'string' } },
	url: { type: 'string', format: 'uri' },
});

const valid: Row = {
	fileName: 'post-1.md',
	frontmatter: {
		title: 'Hello',
		status: 'draft',
		count: 3,
		score: 4.5,
		live: true,
		tags: ['a', 'b'],
		url: 'https://x.com',
		extraKey: 'kept',
	},
	body: '',
};

const incomplete: Row = {
	fileName: 'post-2.md',
	frontmatter: { title: 'Partial' }, // missing required fields -> MISSING_REQUIRED -> NULL
	body: '',
};

const invalid: Row = {
	fileName: 'post-3.md',
	frontmatter: {
		title: 'Bad',
		status: 'bogus', // not in the enum -> INVALID, kept raw
		count: 1.5, // not an integer -> INVALID, kept raw
		score: 2,
		live: false,
		tags: ['x'],
		url: 'https://y.com',
	},
	body: '',
};

describe('schema script (DROP + CREATE, one execute_batch)', () => {
	test('drops then recreates: stem PK, one nullable column per field by storage class, _extra JSON, body', () => {
		const { schema } = projectToSqlite('posts', m, []);
		// Both tables are dropped first, always (the FTS drop runs even when not searchable, so losing
		// searchability cannot leave a stale index).
		expect(schema).toContain('DROP TABLE IF EXISTS "posts";\n');
		expect(schema).toContain('DROP TABLE IF EXISTS "posts_fts";\n');
		// `.toContain`, not `.toBe`: m is searchable (default), so the FTS5 block follows the base table.
		expect(schema).toContain(
			'CREATE TABLE "posts" (' +
				'"stem" TEXT PRIMARY KEY, ' +
				'"title" TEXT, ' +
				'"status" TEXT, ' +
				'"count" INTEGER, ' +
				'"score" REAL, ' +
				'"live" INTEGER, ' +
				'"tags" TEXT, ' +
				'"url" TEXT, ' +
				'"_extra" TEXT NOT NULL, ' +
				'"body" TEXT)',
		);
	});

	test('field identifiers with quotes/spaces are escaped, and stay nullable', () => {
		const weird = contract({ 'a "b"': { type: 'string' } });
		const { schema } = projectToSqlite('posts', weird, []);
		expect(schema).toContain('"a ""b""" TEXT');
		expect(schema).not.toContain('"a ""b""" TEXT NOT NULL');
	});

	test('the table name is the folder name, quoted', () => {
		const { schema, insert } = projectToSqlite('my posts', m, []);
		expect(schema).toContain('CREATE TABLE "my posts" (');
		expect(schema).toContain('DROP TABLE IF EXISTS "my posts"');
		expect(insert).toContain('INSERT INTO "my posts" (');
	});
});

describe('insert template (one ? per column, bound positionally)', () => {
	test('lists every column in order with one placeholder each', () => {
		const { insert } = projectToSqlite('posts', m, []);
		expect(insert).toBe(
			'INSERT INTO "posts" (' +
				'"stem", "title", "status", "count", "score", "live", "tags", "url", "_extra", "body"' +
				') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
		);
		// stem + 7 typed fields + _extra + body = 10 placeholders.
		expect((insert.match(/\?/g) ?? []).length).toBe(10);
	});
});

describe('rows (every readable row, serialized by conformance state)', () => {
	const conformance = classifyRows(m.fields, [valid, incomplete]);
	const proj = projectToSqlite('posts', m, conformance);

	test('valid AND incomplete rows both project, in folder order', () => {
		expect(proj.rows).toHaveLength(2);
		expect(proj.rows.map((r) => r[0])).toEqual(['post-1', 'post-2']);
	});

	test('an OK cell is serialized to its storage class, and the body rides along', () => {
		const [stem, title, status, count, score, live, tags, url, extra, body] =
			proj.rows[0]!;
		expect(stem).toBe('post-1');
		expect(title).toBe('Hello');
		expect(status).toBe('draft');
		expect(count).toBe(3); // INTEGER stays a number
		expect(score).toBe(4.5); // REAL stays a number
		expect(live).toBe(1); // boolean -> 0/1
		expect(tags).toBe('["a","b"]'); // array -> JSON TEXT
		expect(url).toBe('https://x.com');
		expect(extra).toBe('{"extraKey":"kept"}'); // untyped keys -> _extra JSON
		expect(body).toBe(''); // the markdown body, projected verbatim (empty here)
	});

	test('a missing required cell binds NULL (the draft is still a row)', () => {
		const [stem, title, status, count, , , tags, url, extra] = proj.rows[1]!;
		expect(stem).toBe('post-2');
		expect(title).toBe('Partial');
		expect(status).toBeNull();
		expect(count).toBeNull();
		expect(tags).toBeNull();
		expect(url).toBeNull();
		expect(extra).toBe('{}'); // no untyped keys
	});

	test('a MISSING_OPTIONAL cell binds NULL while the row stays valid', () => {
		const optionalContract = contract(
			{
				title: { type: 'string' },
				reviewBy: { type: 'string', format: 'date' },
			},
			['reviewBy'],
		);
		const row: Row = {
			fileName: 'person.md',
			frontmatter: { title: 'Alice', reviewBy: null },
			body: '',
		};
		const conformance = classifyRows(optionalContract.fields, [row]);
		expect(conformance[0]?.rowValid).toBe(true);
		expect(conformance[0]?.cells.map((cell) => cell.state)).toEqual([
			'OK',
			'MISSING_OPTIONAL',
		]);
		const p = projectToSqlite('posts', optionalContract, conformance);
		expect(p.rows[0]).toEqual(['person', 'Alice', null, '{}', '']);
	});

	test('an out-of-domain cell keeps its raw value so the draft stays filterable', () => {
		const p = projectToSqlite('posts', m, classifyRows(m.fields, [invalid]));
		const [stem, title, status, count] = p.rows[0]!;
		expect(stem).toBe('post-3');
		expect(title).toBe('Bad');
		expect(status).toBe('bogus'); // not in the enum, kept raw
		expect(count).toBe(1.5); // not an integer, kept raw
	});
});

describe('FTS5 block (emitted when the contract is searchable)', () => {
	test('appends the virtual table and AFTER INSERT trigger over the searchable columns', () => {
		// m's searchable defaults to body plus its TEXT fields (title, status, tags, url); the numeric
		// and boolean fields (count, score, live) are not full-text.
		const { schema } = projectToSqlite('posts', m, []);
		expect(schema).toContain('DROP TABLE IF EXISTS "posts_fts"');
		expect(schema).toContain(
			'CREATE VIRTUAL TABLE "posts_fts" USING fts5(' +
				'"body", "title", "status", "tags", "url", ' +
				"content='posts', content_rowid=rowid)",
		);
		expect(schema).toContain(
			'CREATE TRIGGER "posts_fts_ai" AFTER INSERT ON "posts" BEGIN',
		);
		expect(schema).toContain(
			'INSERT INTO "posts_fts"(rowid, "body", "title", "status", "tags", "url") ' +
				'VALUES (new.rowid, new."body", new."title", new."status", new."tags", new."url")',
		);
	});

	test('no FTS create or trigger when searchable is empty, but the index drop still runs', () => {
		const built = expectOk(
			validateContract({
				fields: { title: { type: 'string' } },
				searchable: [],
			}),
		);
		const { schema } = projectToSqlite('posts', built, []);
		expect(schema).not.toContain('fts5');
		expect(schema).not.toContain('CREATE TRIGGER');
		// The DROP still runs, so a folder that just lost searchability sheds its stale index.
		expect(schema).toContain('DROP TABLE IF EXISTS "posts_fts"');
	});

	test('losing searchability drops the stale index, so no old word matches a new row (bun:sqlite)', () => {
		const db = new Database(':memory:');

		// First projection: searchable, with a distinctive body word.
		const searchable = projectToSqlite(
			'posts',
			m,
			classifyRows(m.fields, [
				{ ...valid, fileName: 'alpha.md', body: 'hunter2' },
			]),
		);
		db.exec(searchable.schema);
		for (const row of searchable.rows)
			db.prepare(searchable.insert).run(...row);
		expect(
			db
				.query(
					`SELECT count(*) AS n FROM "posts_fts" WHERE "posts_fts" MATCH '"hunter2"'`,
				)
				.get(),
		).toEqual({ n: 1 });

		// Re-project the SAME folder as non-searchable, with a different row at the same rowid.
		const bare = expectOk(
			validateContract({
				fields: { title: { type: 'string' } },
				searchable: [],
			}),
		);
		const nonSearchable = projectToSqlite(
			'posts',
			bare,
			classifyRows(bare.fields, [
				{
					fileName: 'beta.md',
					frontmatter: { title: 'Beta' },
					body: 'something else',
				},
			]),
		);
		db.exec(nonSearchable.schema);
		for (const row of nonSearchable.rows)
			db.prepare(nonSearchable.insert).run(...row);

		// The stale index is gone (not left mapping "hunter2" to whatever now sits at that rowid).
		expect(
			db.query(`SELECT name FROM sqlite_master WHERE name = 'posts_fts'`).all(),
		).toEqual([]);
	});

	test('the trigger fills the index so a body word and a text-field word both match (bun:sqlite)', () => {
		const withBody: Row = {
			...valid,
			fileName: 'note-1.md',
			body: 'the quick brown fox',
		};
		const { schema, insert, rows } = projectToSqlite(
			'posts',
			m,
			classifyRows(m.fields, [withBody]),
		);
		const db = new Database(':memory:');
		db.exec(schema);
		const stmt = db.prepare(insert);
		for (const row of rows) stmt.run(...row);

		const search = (term: string) =>
			db
				.query(
					`SELECT p."stem" AS stem FROM "posts_fts"
					 JOIN "posts" p ON p.rowid = "posts_fts".rowid
					 WHERE "posts_fts" MATCH '"${term}"'`,
				)
				.all() as { stem: string }[];

		expect(search('fox')).toEqual([{ stem: 'note-1' }]); // a body word
		expect(search('Hello')).toEqual([{ stem: 'note-1' }]); // a title (text field) word
		expect(search('absent')).toEqual([]); // no match
	});
});

describe('projects a vault into one db whose tables JOIN', () => {
	// W5's payoff: one db per vault, one SQL table per folder NAMED for the folder, so a cross-table
	// JOIN falls out of real table names with no new code. This drives the real projector over the
	// bundled content-vault and runs its SQL through bun:sqlite (the same engine the Tauri command
	// uses), so the success criterion is proven end to end, not asserted on the SQL strings alone.
	const exampleVault = findExampleVault();

	test('adaptations JOIN pages on the reference column returns the resolved rows', async () => {
		// Load the fixture and project every typed table into one in-memory db, exactly as the Vault
		// fills its shared .matter db (each folder -> a table named for the folder).
		const tables = await loadPath(exampleVault);
		const db = new Database(':memory:');
		for (const table of tables) {
			if (table.status !== 'readable' || table.read.view.mode !== 'typed')
				continue;
			const { schema, insert, rows } = projectToSqlite(
				table.name,
				table.read.view.contract,
				table.read.view.conformance,
			);
			db.exec(schema); // DROP + CREATE for this folder's table
			const stmt = db.prepare(insert);
			for (const row of rows) stmt.run(...row);
		}

		// `adaptations.page` holds a page's stem (basename, no extension), and the mirror's `stem`
		// column IS that same reference identity, so the JOIN key is just `a.page = p.stem` — no
		// `.md` juggling. An INNER JOIN naturally drops the deliberately-dangling orphan-adaptation
		// (page `ghost-page`, which has no pages row).
		const joined = db
			.query(
				`SELECT a."stem" AS adaptation, p."stem" AS page
				 FROM adaptations a JOIN pages p ON a."page" = p."stem"
				 ORDER BY a."stem"`,
			)
			.all() as { adaptation: string; page: string }[];

		expect(joined).toEqual([
			{
				adaptation: 'become-the-source-carousel',
				page: 'become-the-source',
			},
			{
				adaptation: 'become-the-source-thread',
				page: 'become-the-source',
			},
			{
				adaptation: 'plan-yourself-short',
				page: 'how-we-plan-ourselves',
			},
		]);
	});
});

describe('a field named like a mirror column', () => {
	// SQLite column names are case-insensitive, so a typed field called `body` (or `Stem`, or
	// `_extra`) collides with the columns every mirror carries. The mirror must still build.
	const clash = contract({
		title: { type: 'string' },
		body: { type: 'string' },
		Stem: { type: 'string' },
	});
	const row: Row = {
		fileName: 'note-1.md',
		frontmatter: { title: 'Hello', body: 'a summary', Stem: 'root' },
		body: 'The prose of the note.',
	};

	test('projects into a real SQLite table, keeping the clashing values in _extra', () => {
		const { schema, insert, rows } = projectToSqlite(
			'notes',
			clash,
			classifyRows(clash.fields, [row]),
		);
		const db = new Database(':memory:');
		db.exec(schema);
		const stmt = db.prepare(insert);
		for (const r of rows) stmt.run(...r);

		expect(
			db.query('SELECT "stem", "title", "_extra", "body" FROM notes').all(),
		).toEqual([
			{
				stem: 'note-1',
				title: 'Hello',
				_extra: '{"body":"a summary","Stem":"root"}',
				body: 'The prose of the note.',
			},
		]);
		// The full-text index still covers the prose.
		expect(
			db
				.query(`SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'prose'`)
				.all(),
		).toHaveLength(1);
	});
});
