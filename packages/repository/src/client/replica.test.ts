/**
 * Client Replica Tests
 *
 * What the replica's SQLite database adds to the replica, whose sync behavior
 * the property and scenario tests in `src/sim/` cover: the binding
 * to one repository, server and account; a restart from the database file
 * alone; and the read side an app queries. Requests are answered by a real
 * server, by hand, so each test decides what is delivered and what is lost.
 *
 * Key behaviors:
 * - A database bound to another repository, server or account is refused at open, and a hello naming another is refused; a replica with no server refuses every hello
 * - A commit in flight whose answer was lost survives closing and reopening the database file: the reopened replica keeps its device id and sends the same commit, which lands once
 * - No text is kept in memory: reads and saves read the database, and a catch-up's pages are staged there, started again after a restart
 * - A database made before the fold column (phase 5) opens, the column filled from each path
 * - One clash is one block: unsent text replayed over a block that offers its base continues that block
 * - The app's views read what the person sees, held text included, and a watcher hears each changed path after its change is stored
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createTestServer, STAMP, writer } from '../sim/harness.js';
import { openBunSqlite } from '../bun/sqlite.js';
import { findConflicts } from '../core/conflict.js';
import { BODY_SQL } from '../core/markdown.js';
import { defineApp } from '../core/lens.js';
import type { LiveCommit } from '../core/commit.js';
import { commitId } from '../core/commit.js';
import type { Event, Server } from '../server/server.js';
import type { SqlDriver } from '../sql.js';
import { type Binding, openReplica, type Replica, type Reply, type Request } from './replica.js';

const PATH = 'notes/a.md';
const note = (body: string, title = 'A') => `---\ntitle: ${title}\n---\n${body}`;
const SERVER = 'example';
const BINDING: Binding = { repository: 'r1', server: SERVER, account: 'alice' };

const open = (driver: SqlDriver, options: Partial<Parameters<typeof openReplica>[0]> = {}) =>
	openReplica({ driver, binding: BINDING, device: 'laptop', after: () => {}, now: () => 0, ...options });

/** The server's reply to one request, as the wire would carry it. */
function answer(server: Server, request: Request, session = writer('alice')): Reply {
	switch (request.type) {
		case 'push':
			return { type: 'answer', rid: request.rid, answer: server.push(request.commit, session) };
		case 'catch-up':
			return { type: 'caught-up', rid: request.rid, catchUp: server.catchUp(request) };
		case 'fetch':
			return { type: 'fetched', rid: request.rid, texts: server.fetch(request.hashes) };
	}
}

/** Attach `replica` to `server`; `deliver` answers what it sent, until it sends nothing more, as `session` (alice, a writer). */
function connect(replica: Replica, server: Server) {
	const sent: Request[] = [];
	const pushes: LiveCommit[] = [];
	replica.attach((request) => sent.push(request));
	return {
		sent,
		pushes,
		deliver(session = writer('alice')) {
			for (let request = sent.shift(); request !== undefined; request = sent.shift()) {
				if (request.type === 'push') pushes.push(request.commit);
				replica.reply(answer(server, request, session));
			}
		},
	};
}

const bytes = (commit: LiveCommit) => new TextEncoder().encode(JSON.stringify(commit)).length;

test("commits fit the server's bounds from the hello: saves split into several, a group saved together kept whole", () => {
	const server = createTestServer({ limits: { request: 3_000 } });
	const replica = unwrap(open(openBunSqlite()));
	expectOk(replica.hello({ ...BINDING, server: SERVER, main: server.main(), user: 'alice', limits: server.sizing() }));
	const link = connect(replica, server);
	link.deliver();
	replica.attach(null);
	// Offline, the saves amend one unsent commit far larger than one request.
	for (const name of ['a', 'b', 'c', 'd']) replica.write(`notes/${name}.md`, note(`${name.repeat(900)}\n`));
	replica.writeAll({ 'notes/e.md': note(`${'e'.repeat(500)}\n`), 'notes/f.md': note(`${'f'.repeat(500)}\n`) });
	replica.attach(link.sent.push.bind(link.sent));
	link.deliver();
	expect(link.pushes.length).toBeGreaterThan(2);
	for (const commit of link.pushes) expect(bytes(commit)).toBeLessThanOrEqual(3_000);
	const together = link.pushes.find((commit) => commit.files.some((f) => f.path === 'notes/e.md'));
	expect(together?.files.map((f) => f.path).sort()).toEqual(['notes/e.md', 'notes/f.md']);
	expect(replica.held()).toEqual([]);
	expect(server.read('notes/d.md')).toBe(note(`${'d'.repeat(900)}\n`));
	expect(replica.busy()).toBe(false);
});

test('saves made in a batch keep their own groups and are cut once, as the same commit saves made one by one make', () => {
	const each = (batched: boolean) => {
		const server = createTestServer();
		const replica = unwrap(open(openBunSqlite()));
		expectOk(replica.hello({ ...BINDING, server: SERVER, main: server.main(), user: 'alice', limits: server.sizing() }));
		const link = connect(replica, server);
		link.deliver();
		replica.attach(null);
		const before = replica.stats().commits;
		const save = () => {
			replica.writeAll({ 'notes/a.md': note('a\n') });
			replica.writeAll({ 'notes/b.md': note('b\n'), 'notes/c.md': note('c\n') });
			replica.writeAll({ 'notes/d.md': note('d\n') });
		};
		if (batched) replica.batch(save);
		else save();
		const cuts = replica.stats().commits - before;
		replica.attach(link.sent.push.bind(link.sent));
		link.deliver();
		return { cuts, pushed: link.pushes.map((commit) => commit.files.map((f) => f.path).sort()), server: server.snapshot() };
	};
	const one = each(false);
	const batched = each(true);
	expect(one.cuts).toBe(3);
	expect(batched.cuts).toBe(1);
	expect(batched.pushed).toEqual(one.pushed);
	expect(batched.server).toEqual(one.server);
});

test('a commit rejected as too large is split between groups; a group too large alone is held whole, its text kept, until less is saved', () => {
	const server = createTestServer({ limits: { request: 3_000 } });
	const replica = unwrap(open(openBunSqlite()));
	const link = connect(replica, server);
	link.deliver();
	replica.attach(null);
	for (const name of ['a', 'b', 'c', 'd']) replica.write(`notes/${name}.md`, note(`${name.repeat(900)}\n`));
	replica.attach(link.sent.push.bind(link.sent));
	link.deliver();
	expect(replica.held()).toEqual([]);
	expect(server.read('notes/d.md')).toBe(note(`${'d'.repeat(900)}\n`));
	const big = { 'notes/x.md': note(`${'x'.repeat(1_600)}\n`), 'notes/y.md': note(`${'y'.repeat(1_600)}\n`) };
	replica.writeAll(big);
	link.deliver();
	const reason = 'request too large: what was saved together goes together; save less at once';
	expect(replica.held().map((h) => [h.path, h.reason])).toEqual([
		['notes/x.md', reason],
		['notes/y.md', reason],
	]);
	expect(replica.read('notes/x.md')).toBe(big['notes/x.md']);
	// Saved again alone, x still waits with y: the group is never split.
	replica.write('notes/x.md', big['notes/x.md']);
	link.deliver();
	expect(server.read('notes/x.md')).toBeNull();
	expect(replica.state('notes/x.md')).toEqual({ status: 'held', reason: 'saved with notes/y.md, which is held' });
	// Less saved: y dropped, x goes.
	replica.write('notes/y.md', null);
	link.deliver();
	expect(server.read('notes/x.md')).toBe(big['notes/x.md']);
	expect(server.read('notes/y.md')).toBeNull();
	expect(replica.held()).toEqual([]);
});

test('a request rejection holds no text: the work stays committed, the files say why, and the next connection sends it', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	const link = connect(replica, server);
	link.deliver();
	replica.write(PATH, note('one\n'));
	link.deliver({ user: 'alice', role: 'reader' });
	expect(replica.held()).toEqual([]);
	expect(replica.state(PATH)).toEqual({ status: 'sending', reason: 'a reader may not write' });
	expect(replica.rejection()).toEqual({ code: 'reader', reason: 'a reader may not write' });
	// Nothing more goes on this connection, even a new save.
	replica.write(PATH, note('one\ntwo\n'));
	expect(link.sent.filter((request) => request.type === 'push')).toEqual([]);
	// Made a writer again, the next connection sends the work.
	replica.attach(null);
	replica.attach(link.sent.push.bind(link.sent));
	link.deliver();
	expect(server.read(PATH)).toBe(note('one\ntwo\n'));
	expect(replica.state(PATH)).toEqual({ status: 'synced' });
	expect(replica.rejection()).toBeNull();
});

test('a database bound to another repository, server or account is refused, and so is a hello naming another', () => {
	const driver = openBunSqlite();
	const replica = expectOk(open(driver));
	expect(expectErr(open(driver, { binding: { ...BINDING, repository: 'r2' } })).name).toBe('BoundElsewhere');
	expect(expectErr(open(driver, { binding: { ...BINDING, account: null } })).name).toBe('BoundElsewhere');
	expect(expectOk(open(driver)).binding()).toEqual(BINDING);

	const hello = { repository: BINDING.repository, server: SERVER, main: 'm', user: 'alice' };
	expect(expectErr(replica.hello({ ...hello, server: 'elsewhere' })).field).toBe('server');
	// A session's user is its account: a replica refuses any other's.
	expect(expectErr(replica.hello({ ...hello, user: 'bob' })).field).toBe('account');
	// A repository kept only here has no account, so no server's hello passes it.
	const kept = expectOk(open(openBunSqlite(), { binding: { ...BINDING, server: null, account: null } }));
	expect(expectErr(kept.hello(hello)).field).toBe('account');
	expectOk(replica.hello(hello));

	// A replica that has met no server records the first one it meets, for good, and a host that does not know it opens it with null.
	const driver2 = openBunSqlite();
	const local = expectOk(open(driver2, { binding: { ...BINDING, server: null } }));
	expectOk(local.hello({ ...hello, server: 'first' }));
	expect(local.binding().server).toBe('first');
	expect(expectErr(local.hello({ ...hello, server: 'second' })).field).toBe('server');
	local.close();
	expect(expectOk(open(driver2, { binding: { ...BINDING, server: null } })).binding().server).toBe('first');
	expect(expectErr(open(driver2, { binding: { ...BINDING, server: 'second' } })).field).toBe('server');
});

test('a commit in flight whose answer was lost survives reopening the database file, and lands once', () => {
	const dir = mkdtempSync(join(tmpdir(), 'replica-'));
	try {
		const file = join(dir, 'replica.sqlite');
		const server = createTestServer();
		let driver = openBunSqlite(file);
		const first = unwrap(open(driver));
		const link = connect(first, server);
		link.deliver();
		first.write(PATH, note('one\n'));
		const [push] = link.sent.splice(0);
		if (push?.type !== 'push') throw new Error('a save sends its commit');
		// The server takes it, and its answer is lost with the process.
		server.push(push.commit, writer('alice'));
		first.close();
		driver.close();

		driver = openBunSqlite(file);
		// The database keeps the device id it was first given.
		const reopened = unwrap(open(driver, { device: 'another' }));
		expect(reopened.device).toBe('laptop');
		expect(reopened.read(PATH)).toBe(note('one\n'));
		expect(reopened.state(PATH)).toEqual({ status: 'sending' });
		const again = connect(reopened, server);
		expect(again.sent[0]).toMatchObject({ type: 'push', commit: { id: push.commit.id } });
		again.deliver();
		expect(server.history().commits).toBe(1);
		expect(server.read(PATH)).toBe(note('one\n'));
		expect(reopened.state(PATH)).toEqual({ status: 'synced' });
		expect(reopened.position()).toBe(server.main());
		driver.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a commit carries the host's clock as its time", () => {
	const at = Date.UTC(2026, 9, 29, 10, 30);
	const replica = unwrap(open(openBunSqlite(), { now: () => at }));
	const server = createTestServer({ clock: () => at });
	const link = connect(replica, server);
	link.deliver();
	replica.write(PATH, note('one\n'));
	const [push] = link.sent;
	expect(push).toMatchObject({ type: 'push', commit: { time: '2026-10-29T10:30:00.000Z' } });
});

test('a notification costs what it names, not every text the device holds', () => {
	const server = createTestServer({ limits: { request: 64 * 1024 * 1024, files: 5_000 } });
	const bob = writer('bob');
	const text = (i: number, version = 0) => note(`${'word '.repeat(1_000)}${version}\n`, `n${i}`);
	const commit = (files: LiveCommit['files']) => {
		const body = { parent: server.main(), author: { user: 'bob', device: 'd' }, time: STAMP, files };
		return { id: commitId(body), ...body };
	};
	server.push(commit(Array.from({ length: 2_000 }, (_, i) => ({ path: `notes/${i}.md`, text: text(i) }))), bob);
	const replica = unwrap(open(openBunSqlite()));
	const link = connect(replica, server);
	link.deliver();
	expect(replica.paths()).toHaveLength(2_000);
	const events: Event[] = [];
	server.subscribe((event) => events.push(event));
	let spent = 0;
	for (let k = 0; k < 20; k++) {
		server.push(commit([{ path: `notes/${k}.md`, text: text(k, k + 1) }]), bob);
		const event = events.shift();
		if (event === undefined) throw new Error('every commit is an event');
		const start = performance.now();
		replica.notify(event);
		link.deliver();
		spent += performance.now() - start;
	}
	expect(replica.position()).toBe(server.main());
	// Hashing every text held took about 90 ms a notification at this size; reading one path's levels takes a few.
	expect(spent / 20).toBeLessThan(15);
});

test("a catch-up's texts are read in batches, and a read that times out is asked again without gathering the pages again", () => {
	const server = createTestServer({ limits: { page: 100, request: 64 * 1024 * 1024 } });
	const commit = (files: LiveCommit['files']) => {
		const body = { parent: server.main(), author: { user: 'bob', device: 'd' }, time: STAMP, files };
		return { id: commitId(body), ...body };
	};
	server.push(commit(Array.from({ length: 600 }, (_, i) => ({ path: `notes/${String(i).padStart(3, '0')}.md`, text: note(`${i}\n`) }))), writer('bob'));
	const timers: (() => void)[] = [];
	const replica = unwrap(open(openBunSqlite(), { after: (_, run) => timers.push(run) }));
	const sent: Request[] = [];
	replica.attach((request) => sent.push(request));
	const answerNext = () => {
		const request = sent.shift();
		if (request !== undefined) replica.reply(answer(server, request));
		return request;
	};
	// Six pages, then the first batch of texts.
	for (let page = 0; page < 6; page++) expect(answerNext()?.type).toBe('catch-up');
	const first = answerNext();
	expect(first?.type === 'fetch' && first.hashes.length).toBe(256);
	// The second batch's reply is lost: its timeout asks for that batch again, not for the pages.
	const lost = sent.shift();
	expect(lost?.type === 'fetch' && lost.hashes.length).toBe(256);
	for (const run of timers.splice(0)) run();
	const again = sent[0];
	expect(again?.type === 'fetch' && lost?.type === 'fetch' && again.hashes).toEqual(lost?.type === 'fetch' ? lost.hashes : []);
	for (let request = answerNext(); request !== undefined; request = answerNext()) expect(request.type).toBe('fetch');
	expect(replica.paths()).toHaveLength(600);
	expect(replica.position()).toBe(server.main());
	expect(replica.stats().catchUps).toBe(1);
});

test('a replica keeps no text in memory: each read and save reads the database, and a restart mid catch-up starts it again', () => {
	const server = createTestServer({ limits: { page: 2, request: 64 * 1024 * 1024 } });
	const body = { parent: server.main(), author: { user: 'bob', device: 'd' }, time: STAMP, files: ['a', 'b', 'c'].map((stem) => ({ path: `notes/${stem}.md`, text: note(`${stem}\n`) })) };
	server.push({ id: commitId(body), ...body }, writer('bob'));
	const directory = mkdtempSync(join(tmpdir(), 'replica-'));
	try {
		const file = join(directory, 'replica.sqlite');
		let driver = openBunSqlite(file);
		let replica = unwrap(open(driver));
		const sent: Request[] = [];
		replica.attach((request) => sent.push(request));
		// One page staged, then the process stops before the next.
		const page = sent.shift();
		if (page !== undefined) replica.reply(answer(server, page));
		expect(driver.all('SELECT path FROM "epicenter/staged"')).toEqual([{ path: 'notes/a.md' }, { path: 'notes/b.md' }]);
		replica.close();
		driver.close();

		driver = openBunSqlite(file);
		replica = unwrap(open(driver));
		expect(driver.all('SELECT path FROM "epicenter/staged"')).toEqual([]);
		connect(replica, server).deliver();
		expect(replica.paths()).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md']);

		// The database is what the replica reads: a text changed beneath it is what it shows, and what a save merges with.
		driver.run('UPDATE "epicenter/files" SET text = ? WHERE path = ?', [note('a\nbelow\n'), 'notes/a.md']);
		expect(replica.read('notes/a.md')).toBe(note('a\nbelow\n'));
		replica.write('notes/a.md', note('above\na\n'), { over: note('a\n') });
		expect(replica.read('notes/a.md')).toBe(note('above\na\nbelow\n'));
		replica.close();
		driver.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the app's views read what the person sees, held text included, and a watcher hears each change once it is stored", () => {
	const app = defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.String() }) } });
	const driver = openBunSqlite();
	const replica = unwrap(open(driver, { app }));
	const link = connect(replica, createTestServer());
	link.deliver();
	const heard: string[][] = [];
	replica.watch((paths) => heard.push(paths));

	replica.write(PATH, note('one\n'));
	expect(heard).toEqual([[PATH]]);
	expect(replica.query('SELECT stem, title, body FROM notes')).toEqual([{ stem: 'a', title: 'A', body: 'one\n' }]);
	link.deliver();
	expect(heard).toEqual([[PATH], [PATH]]);
	expect(replica.state(PATH)).toEqual({ status: 'synced' });

	// Text the door refuses is held, and still what the person sees.
	replica.write(PATH, `---\ntitle: A\ntitle: B\n---\ntwo\n`);
	expect(replica.state(PATH).status).toBe('held');
	expect(replica.query<{ body: string }>('SELECT body FROM notes')).toEqual([{ body: 'two\n' }]);
	expect(replica.query('SELECT path, held IS NOT NULL AS held FROM "epicenter/files"')).toEqual([{ path: PATH, held: 1 }]);
	expect(() => replica.query('DELETE FROM "epicenter/files"')).toThrow();
});

test('one clash is one block: unsent text replayed over an arrived block that offers its base continues that block', () => {
	const server = createTestServer();
	const device = (account: string) => {
		const replica = unwrap(open(openBunSqlite(), { binding: { ...BINDING, account }, device: `${account}-laptop` }));
		const link = connect(replica, server);
		const hello = () => expectOk(replica.hello({ repository: BINDING.repository, server: SERVER, main: server.main(), user: account }));
		hello();
		return {
			replica,
			sync: () => link.deliver(writer(account)),
			catchUp() {
				hello();
				link.deliver(writer(account));
			},
		};
	};
	const alice = device('alice');
	const bob = device('bob');
	alice.replica.write(PATH, note('one\n'));
	alice.sync();
	bob.catchUp();
	// K1 lands; K2 is saved and unsent when Bob's same-line edit arrives, merged into a block with K1.
	alice.replica.write(PATH, note('oneA\n'));
	alice.sync();
	alice.replica.write(PATH, note('oneAB\n'));
	bob.replica.write(PATH, note('oneR\n'));
	bob.sync();
	alice.catchUp();
	const text = alice.replica.read(PATH) ?? '';
	expect(findConflicts(text)).toMatchObject([{ current: 'oneAB\n', base: 'one\n', incoming: 'oneR\n' }]);
	alice.sync();
	bob.catchUp();
	expect(bob.replica.read(PATH)).toBe(text);
});

test('a database made before the fold column opens, the column filled from each path', () => {
	const driver = openBunSqlite();
	// The files table as phase 5 made it: no fold column.
	driver.exec(
		`CREATE TABLE "epicenter/files" (path TEXT PRIMARY KEY, text TEXT, fields TEXT, body TEXT GENERATED ALWAYS AS (${BODY_SQL}) VIRTUAL, base TEXT, hash TEXT, saved INTEGER NOT NULL DEFAULT 0, held TEXT, unknown INTEGER NOT NULL DEFAULT 0) STRICT`,
	);
	driver.run('INSERT INTO "epicenter/files" (path, text, base) VALUES (?, ?, ?)', ['notes/Plan.md', note('one\n'), note('one\n')]);
	const replica = unwrap(open(driver));
	expect(replica.read('notes/Plan.md')).toBe(note('one\n'));
	// Another spelling finds it, through the column just filled.
	expectOk(replica.change([{ kind: 'patch', path: 'notes/plan.md', fields: { title: 'B' } }]));
	expect(replica.read('notes/Plan.md')).toBe(note('one\n', 'B'));
	expect(replica.query('SELECT body FROM "epicenter/files"')).toEqual([{ body: 'one\n' }]);
});

test('a file with nothing left to send leaves its group: a later hold on it never stops what was saved with it', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	const link = connect(replica, server);
	link.deliver();
	replica.writeAll({ 'notes/a.md': note('a\n'), 'notes/b.md': note('b\n') });
	link.deliver();
	// One call saves a with nothing changed and b changed, offline: a has nothing to send, so it is in no group.
	replica.attach(null);
	replica.writeAll({ 'notes/a.md': note('a\n'), 'notes/b.md': note('b\nmore\n') });
	// A later save of a alone that the door refuses holds a, and only a.
	replica.write('notes/a.md', '---\ntitle: [\n---\n');
	expect(replica.state('notes/a.md').status).toBe('held');
	expect(replica.state('notes/b.md')).toEqual({ status: 'sending' });
	replica.attach(link.sent.push.bind(link.sent));
	link.deliver();
	expect(server.read('notes/b.md')).toBe(note('b\nmore\n'));
});

test('a call saved with a message is a commit alone that carries it, never amended: a later save of its file goes in a commit after it', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	expectOk(replica.hello({ ...BINDING, server: SERVER, main: server.main(), user: 'alice', limits: server.sizing() }));
	const link = connect(replica, server);
	link.deliver();
	replica.attach(null);
	replica.write('notes/live.md', note('live\n'));
	replica.writeAll({ 'notes/a.md': note('a\n'), 'notes/b.md': note('b\n') }, { message: 'Summarize October' });
	// Saved again offline: the commit with the message keeps what it said.
	replica.write('notes/a.md', note('a again\n'));
	replica.attach(link.sent.push.bind(link.sent));
	link.deliver();
	expect(link.pushes.map((commit) => [commit.message ?? null, commit.files.map((f) => f.path).sort()])).toEqual([
		[null, ['notes/live.md']],
		['Summarize October', ['notes/a.md', 'notes/b.md']],
		[null, ['notes/a.md']],
	]);
	expect(link.pushes[1]?.files.find((f) => f.path === 'notes/a.md')?.text).toBe(note('a\n'));
	expect(server.read('notes/a.md')).toBe(note('a again\n'));
	expect(replica.busy()).toBe(false);
	// Every call's work is done: no file is in one.
	expect(replica.query('SELECT path FROM "epicenter/files" WHERE call IS NOT NULL UNION SELECT path FROM "epicenter/unsent"')).toEqual([]);
});

test('a group held with a message keeps it, and its writer saving the held file again sends the whole group once, with the newest message', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	expectOk(replica.hello({ ...BINDING, server: SERVER, main: server.main(), user: 'alice', limits: server.sizing() }));
	const link = connect(replica, server);
	link.deliver();
	replica.writeAll({ 'notes/a.md': note('a\n'), 'notes/bad.md': '---\ntitle: [\n---\n' }, { message: 'First try' });
	link.deliver();
	expect(replica.held().map((h) => h.path)).toEqual(['notes/bad.md']);
	expect(replica.state('notes/a.md')).toEqual({ status: 'held', reason: 'saved with notes/bad.md, which is held' });
	expect(server.read('notes/a.md')).toBeNull();
	replica.writeAll({ 'notes/bad.md': note('fixed\n') }, { message: 'Second try' });
	link.deliver();
	expect(link.pushes.map((commit) => [commit.message, commit.files.map((f) => f.path).sort()])).toEqual([['Second try', ['notes/a.md', 'notes/bad.md']]]);
	expect(replica.held()).toEqual([]);
	expect(replica.busy()).toBe(false);
});

test('a commit with a message that comes back unsent (a lost answer, then outcome unknown) goes again with its message', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	expectOk(replica.hello({ ...BINDING, server: SERVER, main: server.main(), user: 'alice', limits: server.sizing() }));
	const link = connect(replica, server);
	link.deliver();
	replica.writeAll({ 'notes/a.md': note('a\n') }, { message: 'Said once' });
	const [push] = link.sent.splice(0);
	expect(push?.type).toBe('push');
	// The server never saw it, and says it cannot tell (its parent left the window).
	if (push?.type === 'push') replica.reply({ type: 'answer', rid: push.rid, answer: { kind: 'outcome-unknown', main: server.main() } });
	link.deliver();
	expect(link.pushes.map((commit) => commit.message)).toEqual(['Said once']);
	expect(server.read('notes/a.md')).toBe(note('a\n'));
});

test('a save with a message over an unsent commit without one amends it, and the commit carries the message', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	expectOk(replica.hello({ ...BINDING, server: SERVER, main: server.main(), user: 'alice', limits: server.sizing() }));
	const link = connect(replica, server);
	link.deliver();
	replica.attach(null);
	replica.write('notes/a.md', note('live\n'));
	replica.writeAll({ 'notes/a.md': note('live\nsaid\n') }, { message: 'Say it' });
	replica.attach(link.sent.push.bind(link.sent));
	link.deliver();
	expect(link.pushes.map((commit) => [commit.message, commit.files.map((f) => f.text)])).toEqual([['Say it', [note('live\nsaid\n')]]]);
});

test('a call reports its own outcome: pending until sent, landed in its commit, or held by its own file; an earlier held call never touches it', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	expectOk(replica.hello({ ...BINDING, server: SERVER, main: server.main(), user: 'alice', limits: server.sizing() }));
	const link = connect(replica, server);
	link.deliver();
	replica.attach(null);
	const held = replica.writeAll({ 'notes/bad.md': '---\ntitle: [\n---\n' }, { message: 'Broken' }).call;
	const good = replica.writeAll({ 'notes/a.md': note('a\n'), 'notes/b.md': note('b\n') }, { message: 'Two notes' }).call;
	expect(replica.outcome(held)).toEqual({ kind: 'held', held: [{ path: 'notes/bad.md', reason: 'does not parse' }] });
	expect(replica.outcome(good)).toEqual({ kind: 'pending', commit: null });
	replica.attach(link.sent.push.bind(link.sent));
	const sending = replica.outcome(good);
	expect(sending).toEqual({ kind: 'pending', commit: replica.sent()?.id ?? 'none' });
	link.deliver();
	expect(replica.outcome(good)).toEqual({ kind: 'landed', commit: link.pushes.at(-1)?.id ?? 'none', conflicts: [], kept: [] });
	expect(link.pushes.at(-1)?.message).toBe('Two notes');
	// Fixing the held file joins its call: the earlier id now reports the call it joined.
	const fixed = replica.writeAll({ 'notes/bad.md': note('fixed\n') }, { message: 'Fixed' }).call;
	link.deliver();
	expect(replica.outcome(held)).toEqual(replica.outcome(fixed));
	expect(replica.outcome(fixed)).toMatchObject({ kind: 'landed', commit: link.pushes.at(-1)?.id });
	expect(link.pushes.at(-1)?.message).toBe('Fixed');
});

test("a call's outcome names a delete that did not take and the paths where a merge wrote conflict blocks", () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	expectOk(replica.hello({ ...BINDING, server: SERVER, main: server.main(), user: 'alice', limits: server.sizing() }));
	const link = connect(replica, server);
	link.deliver();
	replica.write('notes/a.md', note('one\n'));
	replica.write('notes/b.md', note('one\n'));
	link.deliver();
	replica.attach(null);
	// Offline: a delete of a.md and an edit of b.md's line, while someone else edits both.
	const call = replica.writeAll({ 'notes/a.md': null, 'notes/b.md': note('mine\n') }).call;
	const other = server.main();
	const theirs = { parent: other, author: { user: 'bob', device: 'b' }, time: STAMP, files: [{ path: 'notes/a.md', text: note('one\nbob\n') }, { path: 'notes/b.md', text: note('theirs\n') }] };
	expect(server.push({ id: commitId(theirs), ...theirs }, writer('bob')).kind).toBe('applied');
	replica.attach(link.sent.push.bind(link.sent));
	for (let round = 0; round < 4; round++) link.deliver();
	const outcome = replica.outcome(call);
	expect(outcome).toMatchObject({ kind: 'landed', kept: ['notes/a.md'], conflicts: ['notes/b.md'] });
	expect(replica.read('notes/a.md')).toBe(note('one\nbob\n'));
	expect(findConflicts(replica.read('notes/b.md') ?? '')).toHaveLength(1);
});

test('a call that joined a held call keeps reporting it, however many calls come after', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	expectOk(replica.hello({ ...BINDING, server: SERVER, main: server.main(), user: 'alice', limits: server.sizing() }));
	const link = connect(replica, server);
	link.deliver();
	replica.attach(null);
	const first = replica.writeAll({ 'notes/bad.md': '---\ntitle: [\n---\n' }, { message: 'First try' }).call;
	// Saved again, still broken: the first call joins the second, which is held.
	replica.writeAll({ 'notes/bad.md': '---\ntitle: ]\n---\n' }, { message: 'Second try' });
	for (let n = 0; n < 4_400; n++) replica.write('notes/busy.md', note(`${n}\n`));
	expect(replica.outcome(first)).toEqual({ kind: 'held', held: [{ path: 'notes/bad.md', reason: 'does not parse' }] });
});
