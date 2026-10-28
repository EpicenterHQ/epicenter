/**
 * Durable Send Verdict Tests
 *
 * A send whose reply never arrived fails with `Unknown`, which carries the
 * send's id. Its numbered row stays and is sent again; the server answers
 * the retry from its receipt, and the device stores the outcome on the row,
 * across restarts, so `repo.verdict(id)` can say later what happened.
 *
 * Key behaviors:
 * - A lost reply's send is unanswered until it is sent again, then answered with its outcome, across restarts; reading a final verdict removes it
 * - A refused send nobody waited for is answered later as refused, and is still a notice
 * - An applied send answered after its receipt left with a commit promises only that it applied
 * - An id this device never gave a send has no verdict
 * - The server keeps a refused receipt until the device's next batch shows it has the answer
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openBunGitStore } from './bun/git.js';
import { openBunSqlite } from './bun/sqlite.js';
import { createInProcessTransport } from './bun/transport.js';
import { defineApp } from './define.js';
import { openRepository } from './repository.js';
import { createRepositoryServer } from './server/server.js';

const app = defineApp({ notes: { path: 'notes/{stem}.md', schema: Type.Object({ title: Type.Optional(Type.String()) }) } });

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), 'repository-verdict-'));
	let clock = Date.parse('2026-10-28T12:00:00Z');
	const server = createRepositoryServer({ driver: openBunSqlite(), git: await openBunGitStore(join(dir, 'repo.git')), now: () => clock });
	const device = (name: string) => {
		const transport = createInProcessTransport(server, { user: name });
		const file = join(dir, `${name}.sqlite`);
		const make = () => openRepository({ app, driver: openBunSqlite(file), transport, device: name });
		const it = {
			repo: make(),
			transport,
			restart() {
				it.repo.close();
				it.repo = make();
			},
		};
		return it;
	};
	return {
		server,
		device,
		/** Let time pass and commit, so receipts of committed batches go. */
		async commitLater() {
			clock += 8 * 24 * 3600e3;
			expectOk(await server.tick());
		},
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

test('a send whose reply was lost is unanswered until it is sent again, then answered with its outcome, across restarts', async () => {
	const t = await setup();
	const alice = t.device('alice');
	expectOk(await alice.repo.notes.create({ stem: 'log' }, { body: 'x\n' }));
	await alice.repo.flush();
	alice.transport.dropNextReply();
	const lost = expectErr(await alice.repo.send((b) => b.notes.append({ stem: 'log' }, 'y\n', { from: 'latest' })));
	expect(lost).toMatchObject({ name: 'Unknown', id: 2 });
	if (lost.name !== 'Unknown') throw new Error('unreachable');
	expect(await alice.repo.verdict(lost.id)).toEqual({ kind: 'unanswered' });
	alice.restart();
	expect(await alice.repo.verdict(lost.id)).toEqual({ kind: 'unanswered' });
	alice.transport.setOnline(true);
	await alice.repo.flush();
	// The stored verdict survives a restart, and reading it, once final, removes it.
	alice.restart();
	expect(await alice.repo.verdict(lost.id)).toMatchObject({ kind: 'applied', seq: 2, changes: [{ path: 'notes/log.md', at: 'notes/log.md' }] });
	expect(await alice.repo.verdict(lost.id)).toBeNull();
	// A stored verdict is not a batch in the lane: later writes go as usual.
	expectOk(await alice.repo.notes.append({ stem: 'log' }, 'z\n'));
	await alice.repo.flush();
	expect(await t.server.read('notes/log.md')).toBe('x\ny\nz\n');
	expect(await alice.repo.files.list({ sync: 'sending' })).toEqual([]);
	await t.cleanup();
});

test('a refused send nobody waited for is answered later as refused, and is still a notice', async () => {
	const t = await setup();
	const alice = t.device('alice');
	const bob = t.device('bob');
	expectOk(await alice.repo.notes.create({ stem: 'a' }, { fields: { title: 'A' } }));
	await alice.repo.flush();
	await bob.repo.flush();
	const read = await bob.repo.notes.get({ stem: 'a' });
	if (read === null) throw new Error('Bob reads the note');
	expectOk(await alice.repo.notes.set({ stem: 'a' }, 'title', 'Alice'));
	await alice.repo.flush();
	bob.transport.dropNextReply();
	const lost = expectErr(await bob.repo.send((b) => b.notes.set({ stem: 'a' }, 'title', 'Bob', { from: read })));
	if (lost.name !== 'Unknown') throw new Error(`expected Unknown, got ${lost.name}`);
	bob.transport.setOnline(true);
	await bob.repo.flush();
	expect(await bob.repo.verdict(lost.id)).toMatchObject({ kind: 'refused', path: 'notes/a.md', reason: "the field 'title' changed on both sides" });
	expect(await bob.repo.verdict(lost.id)).toBeNull();
	expect((await bob.repo.notices.list()).map((notice) => notice.kind)).toEqual(['refused']);
	await t.cleanup();
});

test('an applied send answered after its receipt left with a commit promises only that it applied', async () => {
	const t = await setup();
	const alice = t.device('alice');
	expectOk(await alice.repo.notes.create({ stem: 'log' }, { body: 'x\n' }));
	await alice.repo.flush();
	alice.transport.dropNextReply();
	const lost = expectErr(await alice.repo.send((b) => b.notes.append({ stem: 'log' }, 'y\n', { from: 'latest' })));
	if (lost.name !== 'Unknown') throw new Error('unreachable');
	await t.commitLater();
	alice.transport.setOnline(true);
	await alice.repo.flush();
	expect(await alice.repo.verdict(lost.id)).toEqual({ kind: 'applied', seq: null, changes: [] });
	await t.cleanup();
});

test('an id this device never gave a send has no verdict', async () => {
	const t = await setup();
	const alice = t.device('alice');
	expect(await alice.repo.verdict(99)).toBeNull();
	await t.cleanup();
});
