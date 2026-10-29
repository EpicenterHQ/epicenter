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
import { createTestServer, writer } from '../b/harness.js';
import { openBunSqlite } from '../bun/sqlite.js';
import { defineApp } from '../core/lens.js';
import type { Server } from '../server/server.js';
import type { SqlDriver } from '../sql.js';
import { type Binding, openReplica, type Replica, type Reply, type Request } from './replica.js';

const PATH = 'notes/a.md';
const note = (body: string, title = 'A') => `---\ntitle: ${title}\n---\n${body}`;
const BINDING: Binding = { repository: 'r1', server: 'https://example.test/r1/', account: 'alice' };

const open = (driver: SqlDriver, options: Partial<Parameters<typeof openReplica>[0]> = {}) =>
	openReplica({ driver, binding: BINDING, device: 'laptop', after: () => {}, now: () => 0, ...options });

/** The server's reply to one request, as the wire would carry it. */
function answer(server: Server, request: Request): Reply {
	switch (request.type) {
		case 'push':
			return { type: 'answer', rid: request.rid, answer: server.push(request.commit, writer('alice')) };
		case 'catch-up':
			return { type: 'caught-up', rid: request.rid, catchUp: server.catchUp(request) };
		case 'fetch':
			return { type: 'fetched', rid: request.rid, texts: server.fetch(request.hashes) };
	}
}

/** Attach `replica` to `server`; `deliver` answers what it sent, until it sends nothing more. */
function connect(replica: Replica, server: Server) {
	const sent: Request[] = [];
	replica.attach((request) => sent.push(request));
	return {
		sent,
		deliver() {
			for (let request = sent.shift(); request !== undefined; request = sent.shift()) replica.reply(answer(server, request));
		},
	};
}

test('a database bound to another repository, server or account is refused, and so is a hello naming another', () => {
	const driver = openBunSqlite();
	const replica = expectOk(open(driver));
	expect(expectErr(open(driver, { binding: { ...BINDING, repository: 'r2' } })).name).toBe('BoundElsewhere');
	expect(expectErr(open(driver, { binding: { ...BINDING, account: null } })).name).toBe('BoundElsewhere');
	expect(expectOk(open(driver)).binding()).toEqual(BINDING);

	const hello = { ...BINDING, main: 'm' };
	expect(expectErr(replica.hello({ ...hello, server: 'https://elsewhere.test/r1/' })).field).toBe('server');
	expect(expectErr(replica.hello({ ...hello, account: 'bob' })).field).toBe('account');
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
