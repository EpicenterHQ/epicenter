/**
 * Starting Point and Reconciliation Tests
 *
 * A person's write starts from what the server will have once this device's
 * queued writes land (the queued projection), never from the text the
 * device shows, which may hold changes merged in from elsewhere or text the
 * device keeps to itself. Every reconciliation keeps this device's text when
 * it differs from what was sent, rebased onto the server's answer. Text the
 * device keeps to itself is written straight into its row here, as a held
 * text would be, to show that nothing decides by which outbox rows exist.
 *
 * Key behaviors:
 * - An acknowledgment keeps text typed after the write it answers
 * - A write after kept text starts from what the server has, so the server gets exactly its text
 * - A broadcast rebases kept text; it survives a restart and is never sent
 * - A write after a broadcast starts from the queued write rebased onto it, which the server made, so it never asks for a base
 * - A write never sends back as its own an edit made elsewhere that it showed
 * - A retry answered from its receipt after a hello never moves the synced text back
 * - A rename put back keeps the text typed at the new name, and the note at the new name is untouched
 * - A database an earlier build made gets the held column and keeps its files, and a held flag becomes its reason
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
import { defineApp } from './core/lens.js';
import { offlineTransport, type Transport } from './engine/ports.js';
import { gitBlobHash } from './core/hash.js';
import { BODY_SQL } from './core/markdown.js';
import type { Batch } from './protocol.js';
import { openRepository } from './repository.js';
import { createRepositoryServer } from './legacy-server/server.js';
import type { SqlDriver } from './sql.js';

const app = defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.Optional(Type.String()) }) } });
const PATH = 'notes/a.md';
const note = (body: string, title = 'A') => `---\ntitle: ${title}\n---\n${body}`;
/** Frontmatter that does not parse: an unclosed quote. */
const broken = (body: string) => `---\ntitle: "A\n---\n${body}`;

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), 'repository-reconcile-'));
	const server = createRepositoryServer({ driver: openBunSqlite(), git: await openBunGitStore(join(dir, 'repo.git')) });
	/** A device whose pushes are recorded, and held while `hold` is set until `release`. */
	const device = (name: string, { file }: { file?: string } = {}) => {
		const inner = createInProcessTransport(server, { user: name });
		const pushed: Batch[] = [];
		let gate: Promise<void> | null = null;
		let open = () => {};
		const transport: Transport = {
			connect(handlers) {
				const link = inner.connect(handlers);
				return {
					...link,
					async push(batch) {
						pushed.push(structuredClone(batch));
						await gate;
						return link.push(batch);
					},
				};
			},
		};
		const driver = openBunSqlite(file);
		const repo = openRepository({ app, driver, transport, device: name });
		return {
			repo,
			driver,
			transport: inner,
			pushed,
			hold() {
				gate = new Promise((resolve) => {
					open = resolve;
				});
			},
			release() {
				gate = null;
				open();
			},
		};
	};
	return { dir, server, device, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Put text in a file's row that this device keeps to itself, as a held text: no outbox row covers it. */
const keepToItself = (driver: SqlDriver, path: string, text: string) =>
	driver.run(`UPDATE "epicenter/files" SET text = ?, fields = NULL, held = 'unparseable' WHERE path = ?`, [text, path]);
const shown = (driver: SqlDriver, path: string) =>
	driver.all<{ text: string | null }>('SELECT text FROM "epicenter/files" WHERE path = ?', [path])[0]?.text ?? null;
const outbox = (driver: SqlDriver) => driver.all<{ n: number }>('SELECT n FROM "epicenter/outbox"').length;

test('an acknowledgment keeps text typed after the write it answers', async () => {
	const t = await setup();
	const alice = t.device('alice');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\ntwo\n' }));
	await alice.repo.flush();
	alice.hold();
	expectOk(await alice.repo.notes.write({ stem: 'a' }, { body: 'one\ntwo\nthree\n' }));
	await Bun.sleep(5);
	keepToItself(alice.driver, PATH, broken('one\ntwo\nthree\nkept\n'));
	alice.release();
	await alice.repo.flush();
	expect(await t.server.read(PATH)).toBe(note('one\ntwo\nthree\n'));
	expect(shown(alice.driver, PATH)).toBe(broken('one\ntwo\nthree\nkept\n'));
	await t.cleanup();
});

test('a write after kept text starts from what the server has, so the server gets exactly its text', async () => {
	const t = await setup();
	const alice = t.device('alice');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\ntwo\n' }));
	await alice.repo.flush();
	keepToItself(alice.driver, PATH, broken('one\ntwo\nkept\n'));
	expectOk(await alice.repo.files.writeText(PATH, note('one\ntwo\nkept\n')));
	await alice.repo.flush();
	expect(await t.server.read(PATH)).toBe(note('one\ntwo\nkept\n'));
	expect(shown(alice.driver, PATH)).toBe(note('one\ntwo\nkept\n'));
	// Its base was the server's text, which the server holds, so it never asked for one.
	expect(alice.pushed.at(-1)?.changes).toMatchObject([{ kind: 'write', base: { hash: expect.any(String) } }]);
	expect(alice.pushed.filter((batch) => batch.n === alice.pushed.at(-1)?.n)).toHaveLength(1);
	await t.cleanup();
});

test('a broadcast rebases kept text; it survives a restart and is never sent', async () => {
	const t = await setup();
	const file = join(t.dir, 'alice.sqlite');
	let alice = t.device('alice', { file });
	const bob = t.device('bob');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\ntwo\nthree\n' }));
	await alice.repo.flush();
	await bob.repo.flush();
	keepToItself(alice.driver, PATH, broken('one\ntwo\nthree\nkept\n'));
	expectOk(await bob.repo.notes.write({ stem: 'a' }, { body: 'ONE\ntwo\nthree\n' }));
	await bob.repo.flush();
	await alice.repo.flush();
	expect(shown(alice.driver, PATH)).toBe(broken('ONE\ntwo\nthree\nkept\n'));
	alice.repo.close();
	alice = t.device('alice', { file });
	await alice.repo.flush();
	expect(shown(alice.driver, PATH)).toBe(broken('ONE\ntwo\nthree\nkept\n'));
	expect(outbox(alice.driver)).toBe(0);
	expect(await t.server.read(PATH)).toBe(note('ONE\ntwo\nthree\n'));
	await t.cleanup();
});

test('a write after a broadcast starts from the queued write rebased onto it, which is what the server made, so it never asks for a base', async () => {
	const t = await setup();
	const alice = t.device('alice');
	const bob = t.device('bob');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\ntwo\nthree\n' }));
	await alice.repo.flush();
	await bob.repo.flush();
	alice.hold();
	expectOk(await alice.repo.notes.write({ stem: 'a' }, { body: 'one\ntwo\nthree\nfour\n' }));
	await Bun.sleep(5);
	// Bob's change lands first and reaches Alice while hers is in flight.
	expectOk(await bob.repo.notes.write({ stem: 'a' }, { body: 'ONE\ntwo\nthree\n' }));
	await bob.repo.flush();
	expectOk(await alice.repo.notes.write({ stem: 'a' }, { body: 'ONE\ntwo\nthree\nfour\nfive\n' }));
	alice.release();
	await alice.repo.flush();
	expect(await t.server.read(PATH)).toBe(note('ONE\ntwo\nthree\nfour\nfive\n'));
	const second = alice.pushed.at(-1);
	// The second write's base is the first write merged onto Bob's, the text the server made of it: one push each, no resend with base texts.
	expect(second?.changes).toMatchObject([{ kind: 'write', base: { hash: gitBlobHash(note('ONE\ntwo\nthree\nfour\n')) } }]);
	expect(alice.pushed.map((batch) => batch.n)).toEqual([1, 2, 3]);
	expect(alice.pushed.some((batch) => batch.changes.some((change) => change.kind === 'write' && change.base?.text !== undefined))).toBe(false);
	await t.cleanup();
});

test('a write starts from what this device promised rebased onto the server, so an edit elsewhere that it showed is never sent back as its own', async () => {
	const t = await setup();
	const alice = t.device('alice');
	const bob = t.device('bob');
	const body = (line: string) => `one\n.\n.\n${line}\n`;
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: body('b0') }));
	await alice.repo.flush();
	await bob.repo.flush();
	alice.hold();
	expectOk(await alice.repo.notes.set({ stem: 'a' }, 'title', 'T1'));
	await Bun.sleep(5);
	// Bob's edit lands and reaches Alice while hers is in flight; she shows it, then writes again.
	expectOk(await bob.repo.notes.write({ stem: 'a' }, { body: body('b1') }));
	await bob.repo.flush();
	expectOk(await alice.repo.notes.set({ stem: 'a' }, 'title', 'T2'));
	// Bob changes the same line again before Alice's second write lands.
	expectOk(await bob.repo.notes.write({ stem: 'a' }, { body: body('b2') }));
	await bob.repo.flush();
	alice.release();
	await alice.repo.flush();
	await bob.repo.flush();
	expect(await t.server.read(PATH)).toBe(note(body('b2'), 'T2'));
	expect(shown(alice.driver, PATH)).toBe(note(body('b2'), 'T2'));
	expect(await alice.repo.notices.list()).toEqual([]);
	// The second write's base held Bob's first edit, which the server applied under Alice's first write.
	const second = alice.pushed.at(-1)?.changes[0];
	expect(second).toMatchObject({ kind: 'write', base: { hash: gitBlobHash(note(body('b1'), 'T1')) } });
	await t.cleanup();
});

test('writes that join one unsent batch start from what is below it now, so edits elsewhere they showed are never sent back as theirs', async () => {
	const t = await setup();
	const alice = t.device('alice');
	const bob = t.device('bob');
	const body = (line: string) => `one\n.\n.\n${line}\n`;
	const bobWrites = async (line: string) => {
		expectOk(await bob.repo.notes.write({ stem: 'a' }, { body: body(line) }));
		await bob.repo.flush();
	};
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: body('b0') }));
	await alice.repo.flush();
	await bob.repo.flush();
	alice.hold();
	expectOk(await alice.repo.notes.set({ stem: 'a' }, 'title', 'T1'));
	await Bun.sleep(5);
	await bobWrites('b1');
	// The first write is in flight, so these two join one batch behind it.
	expectOk(await alice.repo.notes.set({ stem: 'a' }, 'title', 'T2'));
	await bobWrites('b2');
	expectOk(await alice.repo.notes.set({ stem: 'a' }, 'title', 'T3'));
	await bobWrites('b3');
	alice.release();
	await alice.repo.flush();
	// The create, the first write, and one batch for the two that joined it.
	expect([...new Set(alice.pushed.map((batch) => batch.n))]).toEqual([1, 2, 3]);
	expect(await t.server.read(PATH)).toBe(note(body('b3'), 'T3'));
	expect(await alice.repo.notices.list()).toEqual([]);
	await t.cleanup();
});

test('a retry answered from its receipt after a hello never moves the synced text back to before a change made elsewhere', async () => {
	const t = await setup();
	const alice = t.device('alice');
	const bob = t.device('bob');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\ntwo\n' }));
	await alice.repo.flush();
	await bob.repo.flush();
	// Alice's batch lands, but its reply is lost and she goes offline.
	alice.transport.dropNextReply();
	expectOk(await alice.repo.notes.set({ stem: 'a' }, 'title', 'B'));
	await alice.repo.flush();
	expectOk(await bob.repo.notes.write({ stem: 'a' }, { body: 'one\ntwo\nbob\n' }));
	await bob.repo.flush();
	// Her hello brings Bob's change; the retry is then answered from the older receipt.
	alice.transport.setOnline(true);
	await alice.repo.flush();
	await alice.repo.flush();
	const server = await t.server.read(PATH);
	expect(server).toBe(note('one\ntwo\nbob\n', 'B'));
	expect(shown(alice.driver, PATH)).toBe(server);
	expect(alice.driver.all('SELECT synced, seq FROM "epicenter/files" WHERE path = ?', [PATH])).toEqual([{ synced: server, seq: t.server.sequence() }]);
	expect(outbox(alice.driver)).toBe(0);
	await t.cleanup();
});

test('a rename put back keeps the text typed at the new name, and the note at the new name is untouched', async () => {
	const t = await setup();
	const alice = t.device('alice');
	const bob = t.device('bob');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' }, body: 'one\n' }));
	await alice.repo.flush();
	await bob.repo.flush();
	alice.transport.setOnline(false);
	expectOk(await alice.repo.notes.move({ stem: 'a' }, { stem: 'b' }));
	keepToItself(alice.driver, 'notes/b.md', broken('one\nkept\n'));
	expectOk(await bob.repo.notes.create({ stem: 'b' }, { fields: { title: 'Bob' }, body: "bob's\n" }));
	await bob.repo.flush();
	alice.transport.setOnline(true);
	await alice.repo.flush();
	await alice.repo.flush();
	expect(await t.server.read(PATH)).toBe(note('one\n'));
	expect(shown(alice.driver, PATH)).toBe(broken('one\nkept\n'));
	expect(shown(alice.driver, 'notes/b.md')).toBe(note("bob's\n", 'Bob'));
	await t.cleanup();
});

test('a database an earlier build made gets the held column and keeps its files', async () => {
	const driver = openBunSqlite();
	driver.exec(`
		CREATE TABLE "epicenter/files" (path TEXT PRIMARY KEY, text TEXT, fields TEXT, body TEXT GENERATED ALWAYS AS (${BODY_SQL}) VIRTUAL, synced TEXT, hash TEXT, seq INTEGER NOT NULL DEFAULT 0) STRICT;
	`);
	driver.run('INSERT INTO "epicenter/files" (path, text, fields, synced, hash, seq) VALUES (?, ?, ?, ?, ?, ?)', [PATH, note('one\n'), '{"title":"A"}', note('one\n'), gitBlobHash(note('one\n')), 1]);
	const repo = openRepository({ app, driver, transport: offlineTransport });
	expect((await repo.notes.get({ stem: 'a' }))?.fields).toEqual({ title: 'A' });
	expect(driver.all('SELECT path, held FROM "epicenter/files"')).toEqual([{ path: PATH, held: null }]);
	repo.close();
});

test('a database whose held column was a flag keeps its held text, held for not parsing', async () => {
	const driver = openBunSqlite();
	driver.exec(`
		CREATE TABLE "epicenter/files" (path TEXT PRIMARY KEY, text TEXT, fields TEXT, body TEXT GENERATED ALWAYS AS (${BODY_SQL}) VIRTUAL, synced TEXT, hash TEXT, seq INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0) STRICT;
	`);
	driver.run('INSERT INTO "epicenter/files" (path, text, fields, synced, hash, seq, held) VALUES (?, ?, ?, ?, ?, ?, ?)', [PATH, broken('one\n'), null, note('one\n'), gitBlobHash(note('one\n')), 1, 1]);
	const repo = openRepository({ app, driver, transport: offlineTransport });
	expect(await repo.files.readText(PATH)).toMatchObject({ text: broken('one\n'), sync: { state: 'held', reason: 'unparseable' } });
	repo.close();
});
