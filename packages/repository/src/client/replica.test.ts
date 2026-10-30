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
 * - A push in flight whose answer was lost survives closing and reopening the database file: the reopened replica keeps its device id, epoch and seq and sends the same push, which lands once
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
import { openBunSqlite } from '../bun/sqlite.js';
import type { CommitFile, Push } from '../core/commit.js';
import { findConflicts } from '../core/conflict.js';
import { gitBlobHash } from '../core/hash.js';
import { defineApp } from '../core/lens.js';
import { BODY_SQL, writePointer } from '../core/markdown.js';
import type { Event, Server } from '../server/server.js';
import { createTestServer, directPush, writer } from '../sim/harness.js';
import type { SqlDriver } from '../sql.js';
import {
	type Binding,
	openReplica,
	type Replica,
	type Reply,
	type Request,
} from './replica.js';

const PATH = 'notes/a.md';
const note = (body: string, title = 'A') =>
	`---\ntitle: ${title}\n---\n${body}`;
const SERVER = 'example';
const BINDING: Binding = { repository: 'r1', server: SERVER, account: 'alice' };

const open = (
	driver: SqlDriver,
	options: Partial<Parameters<typeof openReplica>[0]> = {},
) =>
	openReplica({
		driver,
		binding: BINDING,
		device: 'laptop',
		after: () => {},
		now: () => 0,
		quiet: 0,
		...options,
	});

/** The server's reply to one request, as the wire would carry it. */
function answer(
	server: Server,
	request: Request,
	session = writer('alice'),
): Reply {
	switch (request.type) {
		case 'push':
			return {
				type: 'answer',
				rid: request.rid,
				answer: server.push(request.push, session),
			};
		case 'catch-up':
			return {
				type: 'caught-up',
				rid: request.rid,
				catchUp: server.catchUp(request),
			};
		case 'fetch':
			return {
				type: 'fetched',
				rid: request.rid,
				versions: server.fetch(request.hashes),
			};
	}
}

/** Attach `replica` to `server`; `deliver` answers what it sent, until it sends nothing more, as `session` (alice, a writer). */
function connect(replica: Replica, server: Server) {
	const sent: Request[] = [];
	const pushes: Push[] = [];
	replica.attach((request) => sent.push(request));
	return {
		sent,
		pushes,
		deliver(session = writer('alice')) {
			for (
				let request = sent.shift();
				request !== undefined;
				request = sent.shift()
			) {
				if (request.type === 'push') pushes.push(request.push);
				replica.reply(answer(server, request, session));
			}
		},
	};
}

const bytes = (push: Push) =>
	new TextEncoder().encode(JSON.stringify(push)).length;

test("pushes fit the server's bounds from the hello: saves split into several", () => {
	const server = createTestServer({ limits: { request: 3_000 } });
	const replica = unwrap(open(openBunSqlite()));
	expectOk(
		replica.hello({
			...BINDING,
			server: SERVER,
			main: server.main(),
			user: 'alice',
			limits: server.sizing(),
		}),
	);
	const link = connect(replica, server);
	link.deliver();
	replica.attach(null);
	// Offline, the saves amend one unsent commit far larger than one request.
	for (const name of ['a', 'b', 'c', 'd'])
		replica.write(`notes/${name}.md`, note(`${name.repeat(900)}\n`));
	replica.writeAll({
		'notes/e.md': note(`${'e'.repeat(500)}\n`),
		'notes/f.md': note(`${'f'.repeat(500)}\n`),
	});
	replica.attach(link.sent.push.bind(link.sent));
	link.deliver();
	expect(link.pushes.length).toBeGreaterThan(2);
	for (const push of link.pushes)
		expect(bytes(push)).toBeLessThanOrEqual(3_000);
	expect(replica.notSent()).toEqual([]);
	expect(server.read('notes/d.md')).toBe(note(`${'d'.repeat(900)}\n`));
	expect(replica.busy()).toBe(false);
});

test('a push rejected as too large is split in half; one file too large alone is held with why, its text kept, and the rest goes', () => {
	const server = createTestServer({ limits: { request: 3_000 } });
	const replica = unwrap(open(openBunSqlite()));
	const link = connect(replica, server);
	link.deliver();
	replica.attach(null);
	for (const name of ['a', 'b', 'c', 'd'])
		replica.write(`notes/${name}.md`, note(`${name.repeat(900)}\n`));
	replica.attach(link.sent.push.bind(link.sent));
	link.deliver();
	expect(replica.notSent()).toEqual([]);
	expect(server.read('notes/d.md')).toBe(note(`${'d'.repeat(900)}\n`));
	// Saved together: x is too large to go even alone, y is not.
	const big = note(`${'x'.repeat(3_200)}\n`);
	replica.writeAll({ 'notes/x.md': big, 'notes/y.md': note('y\n') });
	link.deliver();
	expect(replica.notSent()).toEqual([
		{ path: 'notes/x.md', status: 'waiting', reason: 'request too large' },
	]);
	expect(replica.read('notes/x.md')).toBe(big);
	expect(server.read('notes/y.md')).toBe(note('y\n'));
	// Saved smaller, x goes.
	replica.write('notes/x.md', note('x\n'));
	link.deliver();
	expect(server.read('notes/x.md')).toBe(note('x\n'));
	expect(replica.notSent()).toEqual([]);
});

test('a request rejection holds no text: the work stays committed, the files say why, and the next connection sends it', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	const link = connect(replica, server);
	link.deliver();
	replica.write(PATH, note('one\n'));
	link.deliver({ user: 'alice', role: 'reader' });
	expect(replica.notSent()).toEqual([]);
	expect(replica.state(PATH)).toEqual({
		status: 'sending',
		reason: 'a reader may not write',
	});
	expect(replica.rejection()).toEqual({
		code: 'reader',
		reason: 'a reader may not write',
	});
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
	expect(
		expectErr(open(driver, { binding: { ...BINDING, repository: 'r2' } })).name,
	).toBe('BoundElsewhere');
	expect(
		expectErr(open(driver, { binding: { ...BINDING, account: null } })).name,
	).toBe('BoundElsewhere');
	expect(expectOk(open(driver)).binding()).toEqual(BINDING);

	const hello = {
		repository: BINDING.repository,
		server: SERVER,
		main: 'm',
		user: 'alice',
	};
	expect(
		expectErr(replica.hello({ ...hello, server: 'elsewhere' })).field,
	).toBe('server');
	// A session's user is its account: a replica refuses any other's.
	expect(expectErr(replica.hello({ ...hello, user: 'bob' })).field).toBe(
		'account',
	);
	// A repository kept only here has no account, so no server's hello passes it.
	const kept = expectOk(
		open(openBunSqlite(), {
			binding: { ...BINDING, server: null, account: null },
		}),
	);
	expect(expectErr(kept.hello(hello)).field).toBe('account');
	expectOk(replica.hello(hello));

	// A replica that has met no server records the first one it meets, for good, and a host that does not know it opens it with null.
	const driver2 = openBunSqlite();
	const local = expectOk(
		open(driver2, { binding: { ...BINDING, server: null } }),
	);
	expectOk(local.hello({ ...hello, server: 'first' }));
	expect(local.binding().server).toBe('first');
	expect(expectErr(local.hello({ ...hello, server: 'second' })).field).toBe(
		'server',
	);
	local.close();
	expect(
		expectOk(open(driver2, { binding: { ...BINDING, server: null } })).binding()
			.server,
	).toBe('first');
	expect(
		expectErr(open(driver2, { binding: { ...BINDING, server: 'second' } }))
			.field,
	).toBe('server');
});

test('a push in flight whose answer was lost survives reopening the database file, and lands once', () => {
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
		server.push(push.push, writer('alice'));
		first.close();
		driver.close();

		driver = openBunSqlite(file);
		// The database keeps the device id it was first given.
		const reopened = unwrap(open(driver, { device: 'another' }));
		expect(reopened.device).toBe('laptop');
		expect(reopened.read(PATH)).toBe(note('one\n'));
		expect(reopened.state(PATH)).toEqual({ status: 'sending' });
		const again = connect(reopened, server);
		expect(again.sent[0]).toMatchObject({
			type: 'push',
			push: push.push,
		});
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

test("a push carries the host's clock as its time", () => {
	const at = Date.UTC(2026, 9, 29, 10, 30);
	const replica = unwrap(open(openBunSqlite(), { now: () => at }));
	const server = createTestServer({ clock: () => at });
	const link = connect(replica, server);
	link.deliver();
	replica.write(PATH, note('one\n'));
	const [push] = link.sent;
	expect(push).toMatchObject({
		type: 'push',
		push: { time: '2026-10-29T10:30:00.000Z' },
	});
});

test('a notification costs what it names, not every text the device holds', () => {
	const server = createTestServer({
		limits: { request: 64 * 1024 * 1024, files: 5_000 },
	});
	const bob = writer('bob');
	const text = (i: number, version = 0) =>
		note(`${'word '.repeat(1_000)}${version}\n`, `n${i}`);
	const push = (files: CommitFile[]) =>
		directPush(server, 'bob', files, { device: 'd' });
	server.push(
		push(
			Array.from({ length: 2_000 }, (_, i) => ({
				path: `notes/${i}.md`,
				text: text(i),
			})),
		),
		bob,
	);
	const replica = unwrap(open(openBunSqlite()));
	const link = connect(replica, server);
	link.deliver();
	expect(replica.paths()).toHaveLength(2_000);
	const events: Event[] = [];
	server.subscribe((event) => events.push(event));
	let spent = 0;
	for (let k = 0; k < 20; k++) {
		server.push(push([{ path: `notes/${k}.md`, text: text(k, k + 1) }]), bob);
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
	const server = createTestServer({
		limits: { page: 100, request: 64 * 1024 * 1024 },
	});
	const commit = (files: CommitFile[]) =>
		directPush(server, 'bob', files, { device: 'd' });
	server.push(
		commit(
			Array.from({ length: 600 }, (_, i) => ({
				path: `notes/${String(i).padStart(3, '0')}.md`,
				text: note(`${i}\n`),
			})),
		),
		writer('bob'),
	);
	const timers: (() => void)[] = [];
	const replica = unwrap(
		open(openBunSqlite(), { after: (_, run) => timers.push(run) }),
	);
	const sent: Request[] = [];
	replica.attach((request) => sent.push(request));
	const answerNext = () => {
		const request = sent.shift();
		if (request !== undefined) replica.reply(answer(server, request));
		return request;
	};
	// Six pages, then the first batch of texts.
	for (let page = 0; page < 6; page++)
		expect(answerNext()?.type).toBe('catch-up');
	const first = answerNext();
	expect(first?.type === 'fetch' && first.hashes.length).toBe(256);
	// The second batch's reply is lost: its timeout asks for that batch again, not for the pages.
	const lost = sent.shift();
	expect(lost?.type === 'fetch' && lost.hashes.length).toBe(256);
	for (const run of timers.splice(0)) run();
	const again = sent[0];
	expect(
		again?.type === 'fetch' && lost?.type === 'fetch' && again.hashes,
	).toEqual(lost?.type === 'fetch' ? lost.hashes : []);
	for (
		let request = answerNext();
		request !== undefined;
		request = answerNext()
	)
		expect(request.type).toBe('fetch');
	expect(replica.paths()).toHaveLength(600);
	expect(replica.position()).toBe(server.main());
	expect(replica.stats().catchUps).toBe(1);
});

test('a replica keeps no text in memory: each read and save reads the database, and a restart mid catch-up starts it again', () => {
	const server = createTestServer({
		limits: { page: 2, request: 64 * 1024 * 1024 },
	});
	server.push(
		directPush(
			server,
			'bob',
			['a', 'b', 'c'].map((stem) => ({
				path: `notes/${stem}.md`,
				text: note(`${stem}\n`),
			})),
		),
		writer('bob'),
	);
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
		expect(driver.all('SELECT path FROM "epicenter/staged"')).toEqual([
			{ path: 'notes/a.md' },
			{ path: 'notes/b.md' },
		]);
		replica.close();
		driver.close();

		driver = openBunSqlite(file);
		replica = unwrap(open(driver));
		expect(driver.all('SELECT path FROM "epicenter/staged"')).toEqual([]);
		connect(replica, server).deliver();
		expect(replica.paths()).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md']);

		// The database is what the replica reads: a text changed beneath it is what it shows, and what a save merges with.
		driver.run('UPDATE "epicenter/files" SET text = ? WHERE path = ?', [
			note('a\nbelow\n'),
			'notes/a.md',
		]);
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
	const app = defineApp({
		notes: {
			path: 'notes/{stem}.md',
			schema: Type.Object({ title: Type.String() }),
		},
	});
	const driver = openBunSqlite();
	const replica = unwrap(open(driver, { app }));
	const link = connect(replica, createTestServer());
	link.deliver();
	const heard: string[][] = [];
	replica.watch((paths) => heard.push(paths));

	replica.write(PATH, note('one\n'));
	expect(heard).toEqual([[PATH]]);
	expect(replica.query('SELECT stem, title, body FROM notes')).toEqual([
		{ stem: 'a', title: 'A', body: 'one\n' },
	]);
	link.deliver();
	expect(heard).toEqual([[PATH], [PATH]]);
	expect(replica.state(PATH)).toEqual({ status: 'synced' });

	// A header that does not parse: a note with no fields, its body what follows the header, and it goes.
	const broken = `---\ntitle: A\ntitle: B\n---\ntwo\n`;
	replica.write(PATH, broken);
	expect(replica.state(PATH).status).toBe('sending');
	expect(replica.query('SELECT title, body FROM notes')).toEqual([
		{ title: null, body: 'two\n' },
	]);
	link.deliver();
	// Text the door refuses is held, and still what the person sees.
	const crlf = note('two\n').replaceAll('\n', '\r\n');
	replica.write(PATH, crlf);
	expect(replica.state(PATH).status).toBe('waiting');
	expect(replica.query<{ body: string }>('SELECT body FROM notes')).toEqual([
		{ body: crlf },
	]);
	expect(
		replica.query(
			'SELECT path, held IS NOT NULL AS held FROM "epicenter/files"',
		),
	).toEqual([{ path: PATH, held: 1 }]);
	expect(() => replica.query('DELETE FROM "epicenter/files"')).toThrow();
});

test('one clash is one block: unsent text replayed over an arrived block that offers its base continues that block', () => {
	const server = createTestServer();
	const device = (account: string) => {
		const replica = unwrap(
			open(openBunSqlite(), {
				binding: { ...BINDING, account },
				device: `${account}-laptop`,
			}),
		);
		const link = connect(replica, server);
		const hello = () =>
			expectOk(
				replica.hello({
					repository: BINDING.repository,
					server: SERVER,
					main: server.main(),
					user: account,
				}),
			);
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
	expect(findConflicts(text)).toMatchObject([
		{ current: 'oneAB\n', base: 'one\n', incoming: 'oneR\n' },
	]);
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
	driver.run(
		'INSERT INTO "epicenter/files" (path, text, base) VALUES (?, ?, ?)',
		['notes/Plan.md', note('one\n'), note('one\n')],
	);
	const replica = unwrap(open(driver));
	expect(replica.read('notes/Plan.md')).toBe(note('one\n'));
	// Another spelling finds it, through the column just filled.
	expectOk(
		replica.change([
			{ kind: 'patch', path: 'notes/plan.md', fields: { title: 'B' } },
		]),
	);
	expect(replica.read('notes/Plan.md')).toBe(note('one\n', 'B'));
	expect(replica.query('SELECT body FROM "epicenter/files"')).toEqual([
		{ body: 'one\n' },
	]);
});

test('a database kept by spelling, from before one row per name, opens and converges: two spellings of one path become one file, with every save', () => {
	const server = createTestServer();
	// What main holds: a and c, synced to this device before it was upgraded.
	const seed = unwrap(open(openBunSqlite(), { device: 'seed' }));
	const seeding = connect(seed, server);
	seeding.deliver();
	seed.writeAll({ 'notes/a.md': note('a\n'), 'notes/c.md': note('c\n') });
	seeding.deliver();
	const driver = openBunSqlite();
	// The tables as they were: one row per spelling, keyed by path.
	driver.exec(`
CREATE TABLE "epicenter/files" (path TEXT PRIMARY KEY, fold TEXT NOT NULL, text TEXT, fields TEXT, body TEXT GENERATED ALWAYS AS (${BODY_SQL}) VIRTUAL, base TEXT, hash TEXT, saved INTEGER NOT NULL DEFAULT 0, held TEXT, unknown INTEGER NOT NULL DEFAULT 0, over TEXT) STRICT;
CREATE TABLE "epicenter/unsent" (path TEXT PRIMARY KEY, text TEXT, over TEXT) STRICT;
CREATE TABLE "epicenter/landed" (path TEXT PRIMARY KEY, outcome TEXT NOT NULL) STRICT;
CREATE TABLE "epicenter/staged" (n INTEGER PRIMARY KEY, path TEXT NOT NULL, hash TEXT, deleted INTEGER NOT NULL) STRICT;
CREATE INDEX "epicenter/files/fold" ON "epicenter/files" (fold);
`);
	const row = (path: string, text: string, base: string | null) =>
		driver.run(
			'INSERT INTO "epicenter/files" (path, fold, text, base) VALUES (?, ?, ?, ?)',
			[path, path.toLowerCase(), text, base],
		);
	row('notes/a.md', note('a\nmine\n'), note('a\n'));
	driver.run('INSERT INTO "epicenter/unsent" (path, text) VALUES (?, ?)', [
		'notes/a.md',
		note('a\nmine\n'),
	]);
	driver.run('INSERT INTO "epicenter/landed" (path, outcome) VALUES (?, ?)', [
		'notes/a.md',
		JSON.stringify({ kind: 'landed' }),
	]);
	// Two rows of one path, each with work: what the bug left.
	row('notes/c.md', note('c\nlower\n'), note('c\n'));
	driver.run('INSERT INTO "epicenter/unsent" (path, text) VALUES (?, ?)', [
		'notes/c.md',
		note('c\nlower\n'),
	]);
	row('notes/C.md', note('upper\n'), null);
	driver.run('INSERT INTO "epicenter/unsent" (path, text) VALUES (?, ?)', [
		'notes/C.md',
		note('upper\n'),
	]);
	const replica = unwrap(open(driver));
	expect(replica.paths()).toEqual(['notes/a.md', 'notes/c.md']);
	expect(replica.outcomes()).toEqual([
		{ path: 'notes/a.md', outcome: { kind: 'landed' } },
	]);
	const link = connect(replica, server);
	link.deliver();
	expect(server.read('notes/a.md')).toBe(note('a\nmine\n'));
	const c = server.read('notes/c.md') ?? '';
	for (const line of ['lower', 'upper']) expect(c).toContain(line);
	expect([...server.snapshot().keys()]).toEqual(['notes/a.md', 'notes/c.md']);
	expect(replica.read('notes/C.md')).toBe(c);
	expect(replica.unsent()).toEqual([]);
});

test('a held file holds only itself: what was saved with it goes', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	const link = connect(replica, server);
	link.deliver();
	replica.writeAll({ 'notes/a.md': note('a\n'), 'notes/b.md': note('b\n') });
	link.deliver();
	// One save of a with nothing changed and b changed, offline.
	replica.attach(null);
	replica.writeAll({
		'notes/a.md': note('a\n'),
		'notes/b.md': note('b\nmore\n'),
	});
	// A later save of a alone that the door refuses holds a, and only a.
	replica.write('notes/a.md', 'a\r\n');
	expect(replica.state('notes/a.md').status).toBe('waiting');
	expect(replica.state('notes/b.md')).toEqual({ status: 'sending' });
	replica.attach(link.sent.push.bind(link.sent));
	link.deliver();
	expect(server.read('notes/b.md')).toBe(note('b\nmore\n'));
});

test('a behind answer starts a new epoch: the note lands as a labelled block, and a different blob lands beside', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	const link = connect(replica, server);
	link.deliver();
	const pointer = (c: string) => writePointer({ oid: c.repeat(64), size: 3 });
	for (const c of ['a', 'b', 'c']) {
		server.upload(c.repeat(64), 3);
		replica.present(c.repeat(64), 3);
	}
	replica.writeAll({ [PATH]: note('one\n'), 'media/x.png': pointer('a') });
	link.deliver();
	// Her edit goes out and is lost on the way, twice sent; meanwhile someone else edits both files.
	replica.writeAll({
		[PATH]: note('one\nmine\n'),
		'media/x.png': pointer('b'),
	});
	link.sent.length = 0;
	replica.attach(null);
	replica.attach(link.sent.push.bind(link.sent));
	const resend = link.sent.shift();
	if (resend?.type !== 'push') throw new Error('a resend');
	link.sent.length = 0;
	const other = (files: CommitFile[]) =>
		server.push(
			directPush(server, 'bob', files, { device: 'phone' }),
			writer('bob'),
		);
	other([
		{ path: PATH, text: note('one\ntheirs\n') },
		{ path: 'media/x.png', text: pointer('c') },
	]);
	replica.reply({
		type: 'answer',
		rid: resend.rid,
		answer: { kind: 'behind', main: server.main() },
	});
	link.deliver();
	expect(replica.notSent()).toEqual([]);
	const text = server.read(PATH) ?? '';
	expect(text.startsWith(note('one\ntheirs\n'))).toBe(true);
	expect(findConflicts(text)).toHaveLength(1);
	expect(text).toContain('alice/laptop');
	expect(replica.stats().behind).toBe(1);
	const renewed = link.pushes.at(-1);
	expect(renewed?.epoch).not.toBe(resend.push.epoch);
	expect(renewed?.seq).toBe(1);
	expect(findConflicts(text)[0]?.incoming).toBe(note('one\nmine\n'));
	expect(replica.read(PATH)).toBe(text);
	// The blob forgot its base: different bytes are there, so it lands beside.
	expect(server.read('media/x.png')).toBe(pointer('c'));
	expect(server.read(`media/x (conflict ${'b'.repeat(7)}).png`)).toBe(
		pointer('b'),
	);
	expect(replica.busy()).toBe(false);
});

test('a newer save over a blob write that lost, whose commit was turned away, still says what that write was made over: it lands beside', () => {
	const server = createTestServer();
	const replica = unwrap(open(openBunSqlite()));
	const link = connect(replica, server);
	link.deliver();
	const pointer = (c: string) => writePointer({ oid: c.repeat(64), size: 3 });
	for (const c of ['a', 'b', 'c', 'd']) {
		server.upload(c.repeat(64), 3);
		replica.present(c.repeat(64), 3);
	}
	replica.write('media/x.png', pointer('a'));
	link.deliver();
	server.push(
		directPush(server, 'bob', [{ path: 'media/x.png', text: pointer('b') }]),
		writer('bob'),
	);
	expectOk(
		replica.hello({
			...BINDING,
			server: SERVER,
			main: server.main(),
			user: 'alice',
		}),
	);
	link.deliver();
	expect(replica.read('media/x.png')).toBe(pointer('b'));
	// A save made over `a` (a folder's file read late): it lost, and goes saying so.
	replica.writeAll(
		{ 'media/x.png': pointer('c') },
		{ over: { 'media/x.png': pointer('a') } },
	);
	const push = link.sent.shift();
	if (push?.type !== 'push') throw new Error('a push');
	expect(push.push.files).toEqual([
		{
			path: 'media/x.png',
			base: gitBlobHash(pointer('a')),
			next: { blob: { oid: 'c'.repeat(64), size: 3 } },
		},
	]);
	// Typed over again while it is out; then the push is turned away, and a new connection sends again.
	replica.write('media/x.png', pointer('d'));
	replica.reply({
		type: 'answer',
		rid: push.rid,
		answer: {
			kind: 'rejected',
			code: 'not-member',
			reason: 'not a member',
			main: server.main(),
		},
	});
	replica.attach(null);
	link.sent.length = 0;
	replica.attach(link.sent.push.bind(link.sent));
	link.deliver();
	expect(server.read('media/x.png')).toBe(pointer('b'));
	expect(server.read(`media/x (conflict ${'d'.repeat(7)}).png`)).toBe(
		pointer('d'),
	);
});
