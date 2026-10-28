/**
 * Client API Tests
 *
 * The app API every host shares, over the in-process engine on `bun:sqlite`
 * and the in-process server. The end-to-end scenarios in `e2e.test.ts` run
 * through the same API; these cover what is new to it: open notes, handle
 * live queries, and command ids that make a retried command land once.
 *
 * Key behaviors:
 * - An open note reads synchronously, shows its own writes at once, and follows other devices
 * - Live queries emit only when their result differs
 * - A command submitted twice under one id is applied once and answered twice
 * - Without a server, writes apply and wait in the outbox
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import { openBunGitStore } from './bun/git.js';
import { openBunSqlite } from './bun/sqlite.js';
import { createInProcessTransport } from './bun/transport.js';
import { defineApp } from './define.js';
import { openEngine } from './engine/engine.js';
import { offlineTransport } from './engine/ports.js';
import { openRepository } from './repository.js';
import { createRepositoryServer } from './server/server.js';

const app = defineApp({
	todos: {
		path: 'todos/{stem}.md',
		schema: Type.Object({ title: Type.String(), done: Type.Boolean() }),
	},
});

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), 'repository-client-'));
	const server = createRepositoryServer({ driver: openBunSqlite(), git: await openBunGitStore(join(dir, 'repo.git')) });
	const device = (name: string) => {
		const transport = createInProcessTransport(server, { user: name });
		return { repo: openRepository({ app, driver: openBunSqlite(), transport, device: name }), transport };
	};
	const alice = device('alice');
	const bob = device('bob');
	return { server, alice, bob, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('an open note reads synchronously, shows its own writes at once, and follows other devices', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.todos.create({ stem: 'milk' }, { fields: { title: 'Milk', done: false } }));
	const note = await t.bob.repo.todos.open({ stem: 'milk' });
	expect(note.read()).toMatchObject({ valid: true, fields: { title: 'Milk', done: false } });
	const seen: unknown[] = [];
	note.subscribe((next) => seen.push(next?.fields));

	const done = note.set('done', true);
	expect(note.read()?.fields).toEqual({ title: 'Milk', done: true });
	expect(expectOk(await done)).toMatchObject({ kind: 'applied' });

	expectOk(await t.alice.repo.todos.set({ stem: 'milk' }, 'title', 'Oat milk'));
	await t.bob.repo.flush();
	expect(note.read()?.fields).toEqual({ title: 'Oat milk', done: true });
	expect(seen).toEqual([{ title: 'Milk', done: true }, { title: 'Oat milk', done: true }]);

	expectOk(await t.alice.repo.todos.delete({ stem: 'milk' }));
	await t.bob.repo.flush();
	expect(note.read()).toBeNull();
	note.close();
	await t.cleanup();
});

test('typing through an open note never shows an older text while writes apply', async () => {
	const t = await setup();
	t.bob.transport.setOnline(false);
	const note = await t.bob.repo.todos.open({ stem: 'list' });
	expect(note.read()).toBeNull();
	const shown: (string | undefined)[] = [];
	note.subscribe((next) => shown.push(next?.body));
	for (const body of ['a', 'ab', 'abc']) void note.write({ fields: { title: 'List', done: false }, body });
	await t.bob.repo.flush();
	expect(shown).toEqual(['a', 'ab', 'abc']);
	expect((await t.bob.repo.todos.get({ stem: 'list' }))?.body).toBe('abc');
	await t.cleanup();
});

test('live queries emit only when their result differs', async () => {
	const t = await setup();
	const paths: string[][] = [];
	const counts: unknown[] = [];
	t.bob.repo.todos.live().subscribe((todos) => paths.push(todos.map((todo) => todo.path)));
	t.bob.repo.live('SELECT count(*) AS n FROM todos').subscribe((rows) => counts.push(rows));
	await t.bob.repo.flush();
	expectOk(await t.alice.repo.todos.create({ stem: 'a' }, { fields: { title: 'A', done: false } }));
	await t.bob.repo.flush();
	// A new title re-runs both; the count is the same, so only the list emits.
	expectOk(await t.alice.repo.todos.set({ stem: 'a' }, 'title', 'Apples'));
	await t.bob.repo.flush();
	expect(paths).toEqual([[], ['todos/a.md'], ['todos/a.md']]);
	expect(counts).toEqual([[{ n: 0 }], [{ n: 1 }]]);
	await t.cleanup();
});

test('a command submitted twice under one id is applied once and answered twice', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.todos.create({ stem: 'log' }, { fields: { title: 'Log', done: false }, body: 'one\n' }));
	const transport = createInProcessTransport(t.server, { user: 'bob' });
	transport.setOnline(false);
	const engine = openEngine({ app, driver: openBunSqlite(), transport, device: 'bob-2' });
	transport.setOnline(true);
	await engine.read({ kind: 'flush' });
	const op = { kind: 'append', name: 'todos', params: { stem: 'log' }, text: 'two\n' } as const;
	const first = engine.submit('command-1', [op]);
	const again = engine.submit('command-1', [op]);
	expectOk(await first.local);
	expectOk(await again.local);
	const [settled, retried] = await Promise.all([first.settled, again.settled]);
	expect(expectOk(retried)).toEqual(expectOk(settled));
	// After it settled, the outcome is answered from its outbox row.
	const late = engine.submit('command-1', [op]);
	expect(expectOk(await late.settled)).toEqual(expectOk(settled));
	expect((await engine.read({ kind: 'get', name: 'todos', params: { stem: 'log' } }))?.body).toBe('one\ntwo\n');
	expect(await t.server.read('todos/log.md')).toBe('---\ntitle: Log\ndone: false\n---\none\ntwo\n');
	engine.close();
	await t.cleanup();
});

test('without a server, writes apply and wait in the outbox', async () => {
	const repo = openRepository({ app, driver: openBunSqlite(), transport: offlineTransport });
	const created = repo.todos.create({ stem: 'a' }, { fields: { title: 'A', done: false } });
	expect(await repo.todos.list()).toMatchObject([{ path: 'todos/a.md', valid: true }]);
	await repo.flush();
	expect(await repo.query('SELECT count(*) AS n FROM "epicenter/outbox" WHERE outcome IS NULL')).toEqual([{ n: 1 }]);
	repo.close();
	expect((await created).error?.name).toBe('Closed');
});
