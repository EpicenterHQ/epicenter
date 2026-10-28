/**
 * Read-only SQL Tests
 *
 * `repo.query` and `repo.live(sql)` read the device database through a path
 * that cannot change it. On Bun that is the same connection (so the app's
 * temporary views are there) with `PRAGMA query_only` on for one statement.
 * The browser host runs the same list in `browser-tests/browser.test.ts`.
 *
 * Key behaviors:
 * - A write, a second statement, ATTACH, a transaction and a PRAGMA are refused
 * - After a refusal the database is unchanged and the engine still writes
 * - One read over a view or an engine table runs, with comments and a trailing semicolon
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { openBunSqlite } from './bun/sqlite.js';
import { defineApp } from './define.js';
import { offlineTransport } from './engine/ports.js';
import { ALLOWED_READS, REFUSED_READS } from './read-only.test-support.js';
import { openRepository } from './repository.js';

const app = defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.Optional(Type.String()) }) } });

async function setup() {
	const repo = openRepository({ app, driver: openBunSqlite(), transport: offlineTransport });
	expectOk(await repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\n' }));
	return repo;
}

for (const [what, sql] of Object.entries(REFUSED_READS))
	test(`a read refuses ${what}, and the database is unchanged`, async () => {
		const repo = await setup();
		await expect(repo.query(sql)).rejects.toThrow();
		expect(await repo.query('SELECT path, text FROM "epicenter/files"')).toEqual([{ path: 'notes/a.md', text: '---\ntitle: A\n---\none\n' }]);
		expect(await repo.query('SELECT name FROM pragma_database_list ORDER BY seq')).toEqual([{ name: 'main' }, { name: 'temp' }]);
		// No transaction was left open and the connection still writes.
		expectOk(await repo.notes.write({ stem: 'a' }, { body: 'two\n' }));
		expect((await repo.notes.get({ stem: 'a' }))?.body).toBe('two\n');
	});

for (const [what, sql] of Object.entries(ALLOWED_READS))
	test(`a read runs over ${what}`, async () => {
		const repo = await setup();
		expect((await repo.query(sql)).length).toBe(1);
	});

test('a live query refuses a write too', async () => {
	const repo = await setup();
	const seen: unknown[] = [];
	repo.live(REFUSED_READS['an UPDATE that returns rows']).subscribe((rows) => seen.push(rows));
	await repo.flush();
	expect(seen).toEqual([]);
	expect((await repo.notes.get({ stem: 'a' }))?.body).toBe('one\n');
});
