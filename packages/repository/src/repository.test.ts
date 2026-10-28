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
 * - Unsent writes to one path coalesce into one batch; a sent write is never changed
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
import type { Transport } from './engine/ports.js';
import type { Batch } from './protocol.js';
import { defineApp } from './define.js';
import { openEngine } from './engine/engine.js';
import { offlineTransport } from './engine/ports.js';
import { createRepository, openRepository } from './repository.js';
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

/** A device whose transport records every batch it pushes. */
function recordingDevice(t: Awaited<ReturnType<typeof setup>>, name: string) {
	const inner = createInProcessTransport(t.server, { user: name });
	const pushed: Batch[] = [];
	const transport: Transport = {
		connect(handlers) {
			const link = inner.connect(handlers);
			return {
				...link,
				push(batch) {
					pushed.push(structuredClone(batch));
					return link.push(batch);
				},
			};
		},
	};
	const engine = openEngine({ app, driver: openBunSqlite(), transport, device: name });
	return { engine, inner, pushed, repo: createRepository(app, engine) };
}

const sentTexts = (pushed: Batch[]) => pushed.map((batch) => batch.changes.map((change) => (change.kind === 'write' ? change.text : change.kind)));

test('a burst of writes to one path while unsent sends one batch with the latest text', async () => {
	const t = await setup();
	const bob = recordingDevice(t, 'bob-2');
	await bob.repo.flush();
	bob.inner.setOnline(false);
	const note = await bob.repo.todos.open({ stem: 'list' });
	const typed = ['a', 'ab', 'abc', 'abcd'].map((body) => note.write({ fields: { title: 'List', done: false }, body }));
	await bob.repo.flush();
	expect(await bob.repo.query('SELECT count(*) AS n FROM "epicenter/outbox" WHERE outcome IS NULL')).toEqual([{ n: 1 }]);

	bob.inner.setOnline(true);
	const settled = await Promise.all(typed);
	expect(settled.map((result) => expectOk(result).kind)).toEqual(['applied', 'applied', 'applied', 'applied']);
	// Sending was tried once while offline and again on reconnect: the same one batch.
	const distinct = [...new Set(bob.pushed.map((batch) => JSON.stringify(batch)))].map((json) => JSON.parse(json) as Batch);
	expect(sentTexts(distinct)).toEqual([['---\ntitle: List\ndone: false\n---\nabcd']]);
	// The batch is the create, so its base is still none.
	expect(distinct[0]?.changes[0]).toMatchObject({ kind: 'write', base: null });
	expect(await t.server.read('todos/list.md')).toBe('---\ntitle: List\ndone: false\n---\nabcd');
	note.close();
	bob.engine.close();
	await t.cleanup();
});

test('a write already handed to the transport is never changed; later writes get their own batch', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.todos.create({ stem: 'log' }, { fields: { title: 'Log', done: false }, body: 'zero\n' }));
	const bob = recordingDevice(t, 'bob-2');
	await bob.repo.flush();
	// The server applies the first write, but its reply is lost.
	bob.inner.dropNextReply();
	const one = bob.repo.todos.write({ stem: 'log' }, { body: 'one\n' });
	await bob.repo.flush();
	const two = bob.repo.todos.write({ stem: 'log' }, { body: 'two\n' });
	await bob.repo.flush();
	expect(await bob.repo.query('SELECT count(*) AS n FROM "epicenter/outbox" WHERE outcome IS NULL')).toEqual([{ n: 2 }]);

	bob.inner.setOnline(true);
	expect(expectOk(await one).kind).toBe('applied');
	expect(expectOk(await two).kind).toBe('applied');
	const body = (text: string) => `---\ntitle: Log\ndone: false\n---\n${text}`;
	// The first batch is resent exactly as it was first sent.
	expect(sentTexts(bob.pushed)).toEqual([[body('one\n')], [body('one\n')], [body('two\n')]]);
	expect(bob.pushed[0]).toEqual(bob.pushed[1] as Batch);
	expect(await t.server.read('todos/log.md')).toBe(body('two\n'));
	bob.engine.close();
	await t.cleanup();
});

test('a retried command whose write was coalesced is answered, not applied again', async () => {
	const engine = openEngine({ app, driver: openBunSqlite(), transport: offlineTransport });
	const write = (body: string) => ({ kind: 'write', name: 'todos', params: { stem: 'a' }, input: { fields: { title: 'A', done: false }, body } }) as const;
	expectOk(await engine.submit('c1', [write('a')]).local);
	expectOk(await engine.submit('c2', [write('ab')]).local);
	// A new leader resends both after the first leader lost their answers.
	expectOk(await engine.submit('c1', [write('a')]).local);
	expectOk(await engine.submit('c2', [write('ab')]).local);
	expect((await engine.read({ kind: 'get', name: 'todos', params: { stem: 'a' } }))?.body).toBe('ab');
	expect(await engine.read({ kind: 'query', sql: 'SELECT count(*) AS n FROM "epicenter/outbox"', params: [] })).toEqual([{ n: 1 }]);
	engine.close();
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
