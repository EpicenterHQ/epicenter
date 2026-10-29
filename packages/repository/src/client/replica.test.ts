/**
 * Client Replica Tests
 *
 * What the replica's SQLite database adds to design B's replica, whose sync
 * behavior the property and scenario tests in `src/b/` cover: the binding
 * to one repository, server and account; a restart from the database file
 * alone; and the read side an app queries. Requests are answered by a real
 * server, by hand, so each test decides what is delivered and what is lost.
 *
 * Key behaviors:
 * - A database bound to another repository, server or account is refused at open, and a hello naming another is refused
 * - A commit in flight whose answer was lost survives closing and reopening the database file: the reopened replica sends the same commit, which lands once
 * - The app's views read what the person sees, held text included, and a watcher hears each changed path after its change is stored
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createTestServer, STAMP, writer } from '../b/harness.js';
import { openBunSqlite } from '../bun/sqlite.js';
import { defineApp } from '../core/lens.js';
import type { LiveCommit } from '../core/commit.js';
import { commitId } from '../core/commit.js';
import type { Event, Server } from '../server/server.js';
import type { SqlDriver } from '../sql.js';
import { type Binding, openReplica, type Replica, type Reply, type Request } from './replica.js';

const PATH = 'notes/a.md';
const note = (body: string, title = 'A') => `---\ntitle: ${title}\n---\n${body}`;
const BINDING: Binding = { repository: 'r1', server: 'example', account: 'alice' };

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
	expectOk(replica.hello({ ...BINDING, main: server.main(), user: 'alice', limits: server.sizing() }));
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

test('a commit rejected as too large is split; a group saved together that is too large alone is held, its text kept', () => {
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
	expect(replica.held().map((h) => [h.path, h.reason])).toEqual([
		['notes/x.md', 'request too large: save fewer files at once'],
		['notes/y.md', 'request too large: save fewer files at once'],
	]);
	expect(replica.read('notes/x.md')).toBe(big['notes/x.md']);
	// Saved alone, each fits.
	replica.write('notes/x.md', big['notes/x.md']);
	link.deliver();
	expect(server.read('notes/x.md')).toBe(big['notes/x.md']);
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

	const hello = { ...BINDING, main: 'm', user: 'alice' };
	expect(expectErr(replica.hello({ ...hello, server: 'elsewhere' })).field).toBe('server');
	expect(expectErr(replica.hello({ ...hello, account: 'bob', user: 'bob' })).field).toBe('account');
	// A guest's session names no account: an account's replica refuses it, and a guest's replica refuses an account's.
	expect(expectErr(replica.hello({ ...hello, account: null, user: 'guest-1' })).field).toBe('account');
	const guest = expectOk(open(openBunSqlite(), { binding: { ...BINDING, account: null } }));
	expect(expectErr(guest.hello(hello)).field).toBe('account');
	expectOk(guest.hello({ ...hello, account: null, user: 'guest-1' }));
	expectOk(replica.hello(hello));
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
		const reopened = unwrap(open(driver));
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
		const body = { parent: server.main(), mode: 'merge' as const, author: { user: 'bob', device: 'd' }, time: STAMP, files };
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
