/**
 * Client API Tests
 *
 * The app API every host shares, over the in-process engine on `bun:sqlite`
 * and the in-process server. The end-to-end scenarios in `e2e.test.ts` run
 * through the same API; these cover what is new to it: open notes, handle
 * live queries, and how unsent writes coalesce.
 *
 * Key behaviors:
 * - An open note reads synchronously, shows its own writes at once, and follows other devices
 * - Live queries emit only when their result differs
 * - An open note's edit keeps a change it had not shown yet; a whole-body write replaces it
 * - Unsent writes to one path coalesce into one batch; a sent write is never changed
 * - Without a server, a write resolves once saved and waits in the outbox
 * - A batch the server cannot apply becomes a notice keeping the shown text; a dropped move is told
 * - Notices are live, newest first, dismissed by the person, and capped at a hundred
 * - The size, binary and frontmatter checks a push gets fail the write itself
 * - A refused send whose caller stopped waiting becomes a notice
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openBunGitStore } from './bun/git.js';
import { openBunSqlite } from './bun/sqlite.js';
import { createInProcessTransport } from './bun/transport.js';
import type { Transport } from './engine/ports.js';
import type { Batch, BatchOutcome } from './protocol.js';
import { defineApp, type Notice } from './define.js';
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

/** Save a write and wait until the server has answered it. */
async function landed(device: { repo: { flush(): Promise<void> } }, saved: Promise<Result<undefined, unknown>>) {
	expectOk(await saved);
	await device.repo.flush();
}

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
	await landed(t.alice, t.alice.repo.todos.create({ stem: 'milk' }, { fields: { title: 'Milk', done: false } }));
	const note = await t.bob.repo.todos.open({ stem: 'milk' });
	expect(note.read()).toMatchObject({ valid: true, fields: { title: 'Milk', done: false } });
	const seen: unknown[] = [];
	note.subscribe((next) => seen.push(next?.fields));

	const done = note.set('done', true);
	expect(note.read()?.fields).toEqual({ title: 'Milk', done: true });
	expectOk(await done);

	await landed(t.alice, t.alice.repo.todos.set({ stem: 'milk' }, 'title', 'Oat milk'));
	await t.bob.repo.flush();
	expect(note.read()?.fields).toEqual({ title: 'Oat milk', done: true });
	expect(seen).toEqual([{ title: 'Milk', done: true }, { title: 'Oat milk', done: true }]);

	await landed(t.alice, t.alice.repo.todos.delete({ stem: 'milk' }));
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

test("an open note's edit keeps a change it had not shown yet; a whole-body write replaces it", async () => {
	const repo = openRepository({ app, driver: openBunSqlite(), transport: offlineTransport });
	void repo.todos.create({ stem: 'a' }, { fields: { title: 'A', done: false }, body: 'one\ntwo\nthree\n' });
	const note = await repo.todos.open({ stem: 'a' });
	// Another tab changes the last line; the note shows it only once it reads again.
	void repo.todos.write({ stem: 'a' }, { body: 'one\ntwo\nTHREE\n' });
	expect(note.read()?.body).toBe('one\ntwo\nthree\n');
	void note.edit('ONE\ntwo\nthree\n');
	await repo.flush();
	expect((await repo.todos.get({ stem: 'a' }))?.body).toBe('ONE\ntwo\nTHREE\n');
	expect(note.read()?.body).toBe('ONE\ntwo\nTHREE\n');

	void repo.todos.write({ stem: 'a' }, { body: 'ONE\ntwo!\nTHREE\n' });
	void note.write({ body: 'ONE\ntwo\nTHREE.\n' });
	await repo.flush();
	expect((await repo.todos.get({ stem: 'a' }))?.body).toBe('ONE\ntwo\nTHREE.\n');
	note.close();
	repo.close();
});

test('live queries emit only when their result differs', async () => {
	const t = await setup();
	const paths: string[][] = [];
	const counts: unknown[] = [];
	t.bob.repo.todos.live().subscribe((todos) => paths.push(todos.map((todo) => todo.path)));
	t.bob.repo.live('SELECT count(*) AS n FROM todos').subscribe((rows) => counts.push(rows));
	await t.bob.repo.flush();
	await landed(t.alice, t.alice.repo.todos.create({ stem: 'a' }, { fields: { title: 'A', done: false } }));
	await t.bob.repo.flush();
	// A new title re-runs both; the count is the same, so only the list emits.
	await landed(t.alice, t.alice.repo.todos.set({ stem: 'a' }, 'title', 'Apples'));
	await t.bob.repo.flush();
	expect(paths).toEqual([[], ['todos/a.md'], ['todos/a.md']]);
	expect(counts).toEqual([[{ n: 0 }], [{ n: 1 }]]);
	await t.cleanup();
});

/** A device whose transport records every batch that leaves it. */
function recordingDevice(t: Awaited<ReturnType<typeof setup>>, name: string) {
	const inner = createInProcessTransport(t.server, { user: name });
	const pushed: Batch[] = [];
	const transport: Transport = {
		connect(handlers) {
			const link = inner.connect(handlers);
			return {
				...link,
				async push(batch) {
					const copy = structuredClone(batch);
					const answer = await link.push(batch);
					// Only what left the device: a call refused before sending carries nothing.
					if (answer.error === null || answer.error.sent) pushed.push(copy);
					return answer;
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
	const typed: ReturnType<typeof note.write>[] = [];
	for (const body of ['a', 'ab', 'abc', 'abcd']) {
		typed.push(note.write({ fields: { title: 'List', done: false }, body }));
		// Each write is tried while offline; a batch that never left the device still takes the next write.
		await bob.repo.flush();
	}
	expect(await bob.repo.query('SELECT count(*) AS n FROM "epicenter/outbox"')).toEqual([{ n: 1 }]);

	for (const saved of await Promise.all(typed)) expectOk(saved);
	bob.inner.setOnline(true);
	await bob.repo.flush();
	expect(sentTexts(bob.pushed)).toEqual([['---\ntitle: List\ndone: false\n---\nabcd']]);
	// The batch is the create, so its base is still none.
	expect(bob.pushed[0]?.changes[0]).toMatchObject({ kind: 'write', base: null });
	expect(await t.server.read('todos/list.md')).toBe('---\ntitle: List\ndone: false\n---\nabcd');
	note.close();
	bob.engine.close();
	await t.cleanup();
});

test('a write already handed to the transport is never changed; later writes get their own batch', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.todos.create({ stem: 'log' }, { fields: { title: 'Log', done: false }, body: 'zero\n' }));
	const bob = recordingDevice(t, 'bob-2');
	await bob.repo.flush();
	// The server applies the first write, but its reply is lost.
	bob.inner.dropNextReply();
	const one = bob.repo.todos.write({ stem: 'log' }, { body: 'one\n' });
	await bob.repo.flush();
	const two = bob.repo.todos.write({ stem: 'log' }, { body: 'two\n' });
	await bob.repo.flush();
	expect(await bob.repo.query('SELECT count(*) AS n FROM "epicenter/outbox"')).toEqual([{ n: 2 }]);

	expectOk(await one);
	expectOk(await two);
	bob.inner.setOnline(true);
	await bob.repo.flush();
	const body = (text: string) => `---\ntitle: Log\ndone: false\n---\n${text}`;
	// The first batch is resent exactly as it was first sent.
	expect(sentTexts(bob.pushed)).toEqual([[body('one\n')], [body('one\n')], [body('two\n')]]);
	expect(bob.pushed[0]).toEqual(bob.pushed[1] as Batch);
	expect(await t.server.read('todos/log.md')).toBe(body('two\n'));
	bob.engine.close();
	await t.cleanup();
});

test('without a server, a write resolves once saved on the device and waits in the outbox', async () => {
	const repo = openRepository({ app, driver: openBunSqlite(), transport: offlineTransport });
	expectOk(await repo.todos.create({ stem: 'a' }, { fields: { title: 'A', done: false } }));
	expect(await repo.todos.list()).toMatchObject([{ path: 'todos/a.md', valid: true }]);
	await repo.flush();
	expect(await repo.query('SELECT count(*) AS n FROM "epicenter/outbox"')).toEqual([{ n: 1 }]);
	repo.close();
	expect((await repo.todos.set({ stem: 'a' }, 'done', true)).error?.name).toBe('Closed');
});

// ============================================================================
// What happens to a saved write later: notices
// ============================================================================

/** An engine whose server answers every batch with `answer`, after a hello with no files. */
function answeringDevice(answer: (batch: Batch) => BatchOutcome) {
	const transport: Transport = {
		connect: () => ({
			connected: () => true,
			hello: async () => Ok({ kind: 'changes' as const, seq: 0, files: [] }),
			push: async (batch) => Ok(answer(batch)),
			close() {},
		}),
	};
	return openRepository({ app, driver: openBunSqlite(), transport, device: 'scripted' });
}

const brief = (list: Notice[]) => list.map(({ kind, path, reason, kept }) => ({ kind, path, reason, kept }));

test('a batch the server cannot apply is reverted, and its notice keeps the text the device showed', async () => {
	const repo = answeringDevice(() => ({ kind: 'refused', path: '', reason: 'batch 1 arrived after 3', overlaps: [] }));
	expectOk(await repo.todos.create({ stem: 'a' }, { fields: { title: 'Typed', done: false }, body: 'every word\n' }));
	await repo.flush();
	expect(await repo.todos.get({ stem: 'a' })).toBeNull();
	expect(brief(await repo.notices.list())).toEqual([
		{
			kind: 'protocol',
			path: 'todos/a.md',
			reason: 'batch 1 arrived after 3',
			kept: '---\ntitle: Typed\ndone: false\n---\nevery word\n',
		},
	]);
	repo.close();
});

test('a move whose note was deleted elsewhere is dropped, and the person is told', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.todos.create({ stem: 'a' }, { fields: { title: 'A', done: false } }));
	await t.bob.repo.flush();
	t.bob.transport.setOnline(false);
	expectOk(await t.bob.repo.todos.move({ stem: 'a' }, { stem: 'b' }));
	await landed(t.alice, t.alice.repo.todos.delete({ stem: 'a' }));
	t.bob.transport.setOnline(true);
	await t.bob.repo.flush();
	expect(brief(await t.bob.repo.notices.list())).toEqual([{ kind: 'dropped', path: 'todos/a.md', reason: 'the file to move is gone', kept: null }]);
	expect(await t.bob.repo.todos.list()).toEqual([]);
	await t.cleanup();
});

test('notices are a live list, newest first, that the person dismisses; a device keeps the newest hundred', async () => {
	let n = 0;
	const repo = answeringDevice(() => ({ kind: 'refused', path: '', reason: `fault ${++n}`, overlaps: [] }));
	const seen: number[] = [];
	repo.notices.live().subscribe((list) => seen.push(list.length));
	for (let k = 0; k < 101; k++) {
		expectOk(await repo.todos.create({ stem: `t${k}` }, { fields: { title: 'T', done: false } }));
		await repo.flush();
	}
	const list = await repo.notices.list();
	expect(list).toHaveLength(100);
	expect(list[0]).toMatchObject({ reason: 'fault 101', path: 'todos/t100.md' });
	expect(list.at(-1)).toMatchObject({ reason: 'fault 2' });
	await repo.notices.dismiss(list[0]?.id ?? 0);
	await repo.flush();
	expect((await repo.notices.list())[0]).toMatchObject({ reason: 'fault 100' });
	expect(seen.at(-1)).toBe(99);
	repo.close();
});

test('a write the server would refuse for its file fails at once, before anything is queued', async () => {
	const repo = openRepository({ app, driver: openBunSqlite(), transport: offlineTransport });
	const large = 'x'.repeat(1024 * 1024 + 1);
	expect(expectErr(await repo.todos.create({ stem: 'big' }, { fields: { title: 'Big', done: false }, body: large }))).toMatchObject({
		name: 'NotStorable',
		reason: 'a note may be at most 1 MB',
	});
	expect(expectErr(await repo.todos.create({ stem: 'bin' }, { fields: { title: 'Bin', done: false }, body: 'a\0b' }))).toMatchObject({
		name: 'NotStorable',
		reason: 'a binary file must be stored through Git LFS',
	});
	expectOk(await repo.todos.create({ stem: 'ok' }, { fields: { title: 'Ok', done: false } }));
	// An append that would leave the frontmatter open never parses again.
	const broken = openRepository({ app, driver: openBunSqlite(), transport: offlineTransport });
	expectOk(await broken.todos.create({ stem: 'n' }, {}));
	expect(expectErr(await broken.todos.append({ stem: 'n' }, '---\ntitle: [\n---\n'))).toMatchObject({ name: 'Unparseable' });
	expect(await repo.query('SELECT count(*) AS n FROM "epicenter/outbox"')).toEqual([{ n: 1 }]);
	repo.close();
	broken.close();
});

test('a send refused after its caller stopped waiting becomes a notice holding what it would have written', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.todos.create({ stem: 'a' }, { fields: { title: 'A', done: false } }));
	await t.bob.repo.flush();
	const read = await t.bob.repo.todos.get({ stem: 'a' });
	t.bob.transport.setOnline(false);
	await landed(t.alice, t.alice.repo.todos.set({ stem: 'a' }, 'title', 'Alice'));
	t.bob.transport.setOnline(true);
	await t.bob.repo.flush();
	t.bob.transport.dropNextReply();
	const sent = await t.bob.repo.send((b) => b.todos.set({ stem: 'a' }, 'title', 'Bob', { base: read?.version }));
	expect(expectErr(sent).name).toBe('Unknown');
	t.bob.transport.setOnline(true);
	await t.bob.repo.flush();
	expect(brief(await t.bob.repo.notices.list())).toEqual([
		{ kind: 'refused', path: 'todos/a.md', reason: "the field 'title' changed on both sides", kept: '---\ntitle: Bob\ndone: false\n---\n' },
	]);
	expect((await t.bob.repo.todos.get({ stem: 'a' }))?.fields.title).toBe('Alice');
	await t.cleanup();
});

test('a database an earlier build made drops its settled rows and command ids, and sends what was unsent', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.todos.create({ stem: 'a' }, { fields: { title: 'A', done: false } }));
	const driver = openBunSqlite();
	driver.exec(`
		CREATE TABLE "epicenter/outbox" (n INTEGER PRIMARY KEY, seq INTEGER NOT NULL, changes TEXT NOT NULL, outcome TEXT) STRICT;
		CREATE TABLE "epicenter/commands" (command TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (command, n)) STRICT;
		CREATE TABLE "epicenter/meta" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
		INSERT INTO "epicenter/meta" VALUES ('device', 'old'), ('next', '3'), ('seq', '0'), ('ahead', '[]');
		INSERT INTO "epicenter/outbox" VALUES (1, 0, '[]', '[]');
	`);
	const pending = [{ change: { kind: 'append', path: 'todos/a.md', text: 'more\n', base: { hash: 'x', text: '---\ntitle: A\ndone: false\n---\n' } }, local: null }];
	driver.run('INSERT INTO "epicenter/outbox" VALUES (2, 1, ?, NULL)', [JSON.stringify(pending)]);
	// The settled batch 1 reached the server long ago.
	await t.server.connect({ device: 'old', user: 'old' }).push({ device: 'old', n: 1, seq: 0, policy: 'mark', changes: [] });
	const old = openRepository({ app, driver, transport: createInProcessTransport(t.server, { user: 'old' }) });
	await old.flush();
	expect(await t.server.read('todos/a.md')).toBe('---\ntitle: A\ndone: false\n---\nmore\n');
	expect(await old.query('SELECT count(*) AS n FROM "epicenter/outbox"')).toEqual([{ n: 0 }]);
	expect(await old.query(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'epicenter/commands'`)).toEqual([{ n: 0 }]);
	old.close();
	await t.cleanup();
});
