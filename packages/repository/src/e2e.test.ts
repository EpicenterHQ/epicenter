/**
 * End-to-End Repository Tests
 *
 * Two devices (and sometimes an agent) run the real engine on `bun:sqlite`
 * through the app API every host shares,
 * talk to one real server through the in-process transport, and the server
 * commits to a real bare Git repository. These are the scenarios ADR-0692's
 * design rests on, observed from the app API.
 *
 * Key behaviors:
 * - Edits appear on other devices; offline edits merge on reconnect
 * - Overlaps become marker blocks for people and refusals for agents
 * - Creates at one path merge; moves carry stale edits
 * - A path is a note's field: a rename of a renamed note, or onto a taken name, keeps the current path and tells the person; a send is refused
 * - A change whose path no longer holds its note becomes a sibling note everyone sees
 * - Delete versus edit keeps the edit; root-record sets merge by key; a field set on both keeps the current value and tells the other device; appends keep server order
 * - Retries and need-base; a note and its blob land together; a batch with a move is one server batch
 * - Commits clear the overlay with the right sequence; agent pushes merge or refuse
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openBunGitStore } from './bun/git.js';
import { openBunSqlite } from './bun/sqlite.js';
import { createInProcessTransport } from './bun/transport.js';
import { defineApp } from './define.js';
import { openRepository } from './repository.js';
import { createMemoryBlobStore, type Transport } from './engine/ports.js';
import { gitBlobHash } from './hash.js';
import type { Batch } from './protocol.js';
import { MAIN, sequenceOf } from './server/git-store.js';
import { createRepositoryServer, type ServerOptions } from './server/server.js';

const app = defineApp({
	notes: {
		path: 'notes/{stem}.md',
		schema: Type.Object({ title: Type.Optional(Type.String()), weather: Type.Optional(Type.String()), mood: Type.Optional(Type.String()) }),
	},
	settings: {
		path: 'settings.md',
		schema: Type.Object({ theme: Type.Optional(Type.String()), font: Type.Optional(Type.String()) }),
	},
	photos: { path: 'notes/{stem}/{file}', blob: { types: ['image/png'] } },
});

async function setup(options: Partial<ServerOptions> = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'repository-e2e-'));
	const git = await openBunGitStore(join(dir, 'repo.git'));
	let clock = Date.parse('2026-10-28T12:00:00Z');
	const server = createRepositoryServer({ driver: openBunSqlite(), git, now: () => clock, ...options });
	const blobs = createMemoryBlobStore();
	const device = (name: string, user: string) => {
		const transport = createInProcessTransport(server, { user });
		const repo = openRepository({ app, driver: openBunSqlite(), transport, device: name, blobs });
		return { repo, transport };
	};
	/** A device whose pushes are recorded, and held while `hold` is set until `release`. */
	const gated = (name: string, user: string) => {
		const inner = createInProcessTransport(server, { user });
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
		const repo = openRepository({ app, driver: openBunSqlite(), transport, device: name, blobs });
		return {
			repo,
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
	const alice = device('alice-laptop', 'alice');
	const bob = device('bob-phone', 'bob');
	await Promise.all([alice.repo.flush(), bob.repo.flush()]);
	return {
		server,
		git,
		alice,
		bob,
		device,
		gated,
		advance: (ms: number) => {
			clock += ms;
		},
		/** Run every device's queued sync work until nothing changes. */
		async settle(...devices: { repo: { flush(): Promise<void> } }[]) {
			for (let round = 0; round < 3; round++) for (const d of devices) await d.repo.flush();
		},
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

/** Save a write and wait until the server has answered it. */
async function landed(device: { repo: { flush(): Promise<void> } }, saved: Promise<Result<undefined, unknown>>) {
	expectOk(await saved);
	await device.repo.flush();
}

const notices = (repo: { notices: { list(): Promise<{ kind: string; path: string; reason: string; kept: string | null }[]> } }) =>
	repo.notices.list().then((list) => list.map(({ kind, path, reason, kept }) => ({ kind, path, reason, kept })));

const text = async (repo: { notes: { get(p: { stem: string }): Promise<{ text: string } | null> } }, stem: string) =>
	(await repo.notes.get({ stem }))?.text ?? null;

test('an edit appears on the other device, and its live query re-runs', async () => {
	const t = await setup();
	const seen: unknown[] = [];
	t.bob.repo.live('SELECT stem, title FROM notes').subscribe((rows) => seen.push(rows));
	await t.bob.repo.flush();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'trip' }, { fields: { title: 'Trip' }, body: 'Pack.\n' }));
	expect(t.server.sequence()).toBe(1);
	await t.bob.repo.flush();
	expect(await t.bob.repo.notes.get({ stem: 'trip' })).toMatchObject({ valid: true, fields: { title: 'Trip' }, body: 'Pack.\n', params: { stem: 'trip' } });
	expect(seen).toEqual([[], [{ stem: 'trip', title: 'Trip' }]]);
	await t.cleanup();
});

test('an offline edit on each device merges on reconnect', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'list' }, { body: 'a\nb\nc\n' }));
	t.alice.transport.setOnline(false);
	t.bob.transport.setOnline(false);
	void t.alice.repo.notes.write({ stem: 'list' }, { body: 'A\nb\nc\n' });
	void t.bob.repo.notes.write({ stem: 'list' }, { body: 'a\nb\nC\n' });
	expect(await text(t.alice.repo, 'list')).toBe('A\nb\nc\n');
	t.alice.transport.setOnline(true);
	t.bob.transport.setOnline(true);
	await t.settle(t.alice, t.bob);
	expect(await text(t.alice.repo, 'list')).toBe('A\nb\nC\n');
	expect(await text(t.bob.repo, 'list')).toBe('A\nb\nC\n');
	await t.cleanup();
});

test('a true overlap becomes a marker block for people and a refusal for an agent', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'pet' }, { body: 'cat\n' }));
	const agent = t.device('agent-1', 'claude');
	await agent.repo.flush();
	const read = await agent.repo.notes.get({ stem: 'pet' });
	expect(read?.version).toBe(gitBlobHash('cat\n'));
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.write({ stem: 'pet' }, { body: 'coat\n' });
	await landed(t.alice, t.alice.repo.notes.write({ stem: 'pet' }, { body: 'cart\n' }));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice, agent);
	const marked = (await text(t.alice.repo, 'pet')) ?? '';
	expect(marked).toContain('<<<<<<< alice');
	expect(marked).toContain('cart\n||||||| base\ncat\n=======\ncoat\n>>>>>>> bob');
	expect(await text(t.bob.repo, 'pet')).toBe(marked);

	// The agent changes the note it read; it changed since, so the send is refused and changes nothing.
	const verdict = expectOk(await agent.repo.send((b) => b.notes.write({ stem: 'pet' }, { body: 'cut\n' }, { from: read ?? 'latest' })));
	expect(verdict).toMatchObject({ kind: 'refused', path: 'notes/pet.md' });
	expect(await text(agent.repo, 'pet')).toBe(marked);
	expect(await t.server.read('notes/pet.md')).toBe(marked);
	expect(await agent.repo.query('SELECT count(*) AS n FROM "epicenter/outbox"')).toEqual([{ n: 0 }]);
	await t.cleanup();
});

// ============================================================================
// send: one batch that waits for the server's verdict
// ============================================================================

test('an applied send shows on its own device at once, though the server echoes nothing back', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'task' }, { fields: { title: 'Fix login' }, body: 'Steps.\n' }));
	const agent = t.device('agent-1', 'claude');
	await agent.repo.flush();
	const read = await agent.repo.notes.get({ stem: 'task' });
	const verdict = expectOk(await agent.repo.send((b) => b.notes.set({ stem: 'task' }, 'mood', 'done', { from: read ?? 'latest' })));
	expect(verdict).toMatchObject({ kind: 'applied', seq: 2, changes: [{ path: 'notes/task.md', at: 'notes/task.md' }] });
	const shown = '---\ntitle: Fix login\nmood: done\n---\nSteps.\n';
	expect(await text(agent.repo, 'task')).toBe(shown);
	expect((await agent.repo.notes.get({ stem: 'task' }))?.version).toBe(gitBlobHash(shown));
	expect(await agent.repo.query('SELECT value FROM "epicenter/meta" WHERE key = \'seq\'')).toEqual([{ value: '2' }]);
	await t.alice.repo.flush();
	expect(await text(t.alice.repo, 'task')).toBe(shown);
	await t.cleanup();
});

test("a send from 'latest' starts from the text the server last acknowledged", async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'task' }, { fields: { title: 'A' } }));
	const agent = t.device('agent-1', 'claude');
	await agent.repo.flush();
	await landed(t.alice, t.alice.repo.notes.set({ stem: 'task' }, 'title', 'B'));
	await agent.repo.flush();
	expect(expectOk(await agent.repo.send((b) => b.notes.set({ stem: 'task' }, 'mood', 'calm', { from: 'latest' })))).toMatchObject({ kind: 'applied' });
	expect(await t.server.read('notes/task.md')).toBe('---\ntitle: B\nmood: calm\n---\n');
	await t.cleanup();
});

test("a note's version is the hash of its text, unsent changes and all", async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'task' }, { body: 'one\n' }));
	t.alice.transport.setOnline(false);
	expectOk(await t.alice.repo.notes.write({ stem: 'task' }, { body: 'two\n' }));
	const read = await t.alice.repo.notes.get({ stem: 'task' });
	expect(read?.version).toBe(gitBlobHash('two\n'));
	const open = await t.alice.repo.notes.open({ stem: 'task' });
	void open.write({ body: 'three\n' });
	expect(open.read()?.version).toBe(gitBlobHash('three\n'));
	open.close();
	await t.cleanup();
});

test("a send from a read keeps the person's view: a change it did not read is refused, one beside it applies", async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'day' }, { fields: { title: 'A' }, body: 'one\ntwo\nthree\nfour\n' }));
	await t.bob.repo.flush();
	// Alice's title and second line wait unsent while Bob's land first, so hers are kept out (a field) or marked (a line).
	t.alice.transport.setOnline(false);
	expectOk(await t.alice.repo.notes.write({ stem: 'day' }, { fields: { title: 'X' }, body: 'one\nTWO\nthree\nfour\n' }));
	const read = await t.alice.repo.notes.get({ stem: 'day' });
	if (read === null) throw new Error('no note');
	await landed(t.bob, t.bob.repo.notes.write({ stem: 'day' }, { fields: { title: 'Y' }, body: 'one\n2\nthree\nfour\n' }));
	t.alice.transport.setOnline(true);
	await t.alice.repo.flush();
	const landedText = (await t.server.read('notes/day.md')) ?? '';
	expect(landedText).toContain('title: Y');

	// Another field and another line, from what she read, apply with the current title and line.
	const beside = expectOk(await t.alice.repo.send((b) => b.notes.set({ stem: 'day' }, 'mood', 'calm', { from: read })));
	expect(beside).toMatchObject({ kind: 'applied' });
	const line = expectOk(
		await t.alice.repo.send((b) => b.notes.write({ stem: 'day' }, { body: 'one\nTWO\nthree\nFOUR\n' }, { from: read })),
	);
	expect(line).toMatchObject({ kind: 'applied' });
	const after = (await t.server.read('notes/day.md')) ?? '';
	expect(after).toContain('title: Y\nmood: calm');
	expect(after).toContain('FOUR\n');
	expect(after).not.toContain('title: X');

	// The title, and the second line, which she read as hers, are refused: they did not land as she read them.
	const title = expectOk(await t.alice.repo.send((b) => b.notes.set({ stem: 'day' }, 'title', 'Z', { from: read })));
	expect(title).toMatchObject({ kind: 'refused', path: 'notes/day.md' });
	const second = expectOk(
		await t.alice.repo.send((b) => b.notes.write({ stem: 'day' }, { body: 'one\nzwei\nthree\nfour\n' }, { from: read })),
	);
	expect(second).toMatchObject({ kind: 'refused', path: 'notes/day.md' });
	expect(await t.server.read('notes/day.md')).toBe(after);
	await t.cleanup();
});

test('a send while offline fails at once and queues nothing', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'task' }, { body: 'x\n' }));
	t.alice.transport.setOnline(false);
	await t.alice.repo.flush();
	expect(expectErr(await t.alice.repo.send((b) => b.notes.append({ stem: 'task' }, 'y\n', { from: 'latest' }))).name).toBe('Offline');
	expect(await t.alice.repo.query('SELECT count(*) AS n FROM "epicenter/outbox"')).toEqual([{ n: 0 }]);
	expect(await text(t.alice.repo, 'task')).toBe('x\n');
	await t.cleanup();
});

test('a send whose reply was lost is unknown to its caller, then resent under its number and lands once', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'log' }, { body: 'x\n' }));
	t.alice.transport.dropNextReply();
	const lost = expectErr(await t.alice.repo.send((b) => b.notes.append({ stem: 'log' }, 'y\n', { from: 'latest' })));
	expect(lost).toMatchObject({ name: 'Unknown', n: 2 });
	expect(await t.server.read('notes/log.md')).toBe('x\ny\n');
	// Nothing changed here before the verdict.
	expect(await text(t.alice.repo, 'log')).toBe('x\n');
	t.alice.transport.setOnline(true);
	await t.alice.repo.flush();
	// The retry is answered from the server's receipt, and its result is written here.
	expect(await text(t.alice.repo, 'log')).toBe('x\ny\n');
	expect(await t.server.read('notes/log.md')).toBe('x\ny\n');
	expect(t.server.sequence()).toBe(2);
	expect(await t.alice.repo.query('SELECT count(*) AS n FROM "epicenter/outbox"')).toEqual([{ n: 0 }]);
	await t.cleanup();
});

test('a send waits for earlier writes to its paths, so it starts from what they left', async () => {
	const t = await setup();
	void t.alice.repo.notes.create({ stem: 'log' }, { body: 'one\n' });
	const verdict = expectOk(await t.alice.repo.send((b) => b.notes.append({ stem: 'log' }, 'two\n', { from: 'latest' })));
	expect(verdict).toMatchObject({ kind: 'applied', seq: 2 });
	expect(await t.server.read('notes/log.md')).toBe('one\ntwo\n');
	await t.cleanup();
});

test('a write to a path with a send in flight waits for the verdict and starts from its result', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'task' }, { fields: { title: 'A' } }));
	const agent = t.gated('agent-1', 'claude');
	await agent.repo.flush();
	agent.hold();
	const sent = agent.repo.send((b) => b.notes.set({ stem: 'task' }, 'title', 'B', { from: 'latest' }));
	let written = false;
	const write = agent.repo.notes.set({ stem: 'task' }, 'title', 'C').then((result) => {
		written = true;
		return result;
	});
	await Bun.sleep(10);
	expect(written).toBe(false);
	expect(await text(agent.repo, 'task')).toBe('---\ntitle: A\n---\n');
	agent.release();
	expect(expectOk(await sent)).toMatchObject({ kind: 'applied' });
	expectOk(await write);
	await agent.repo.flush();
	const [, after] = agent.pushed.map((batch) => batch.changes[0]);
	expect(after).toMatchObject({ kind: 'write', base: { hash: gitBlobHash('---\ntitle: B\n---\n') } });
	// Started from the send's result, the write is no clash: its title is kept, not the current one.
	expect(await t.server.read('notes/task.md')).toBe('---\ntitle: C\n---\n');
	await t.cleanup();
});

test('two creates at one path merge fields and keep both bodies', async () => {
	const t = await setup();
	t.alice.transport.setOnline(false);
	t.bob.transport.setOnline(false);
	void t.alice.repo.notes.create({ stem: 'daily' }, { fields: { weather: 'sun' }, body: 'Morning\n' });
	void t.bob.repo.notes.create({ stem: 'daily' }, { fields: { mood: 'good' }, body: 'Evening\n' });
	t.alice.transport.setOnline(true);
	t.bob.transport.setOnline(true);
	await t.settle(t.alice, t.bob);
	const expected = '---\nweather: sun\nmood: good\n---\nMorning\n\nEvening\n';
	expect(await text(t.alice.repo, 'daily')).toBe(expected);
	expect(await text(t.bob.repo, 'daily')).toBe(expected);
	await t.cleanup();
});

test('an overlap touching an existing conflict block keeps both sides as separate blocks', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'pet' }, { body: 'intro\ncat\nend\n' }));
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.write({ stem: 'pet' }, { body: 'intro\ncoat\nend\n' });
	await landed(t.alice, t.alice.repo.notes.write({ stem: 'pet' }, { body: 'intro\ncart\nend\n' }));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	const blocked = (await text(t.alice.repo, 'pet')) ?? '';
	expect(await text(t.bob.repo, 'pet')).toBe(blocked);
	expect(blocked.match(/^<<<<<<< /gm)).toHaveLength(1);

	// Alice edits the intro and a line inside the block; Bob, offline, edits the
	// intro and resolves the block.
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.write({ stem: 'pet' }, { body: 'intro by bob\ncoat\nend\n' });
	await landed(t.alice, t.alice.repo.notes.write({ stem: 'pet' }, { body: blocked.replace('intro', 'intro by alice').replace('cart', 'CART') }));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	const final = (await text(t.alice.repo, 'pet')) ?? '';
	expect(await text(t.bob.repo, 'pet')).toBe(final);
	for (const kept of ['intro by alice', 'CART', 'intro by bob\ncoat\n']) expect(final).toContain(kept);
	expect(final.match(/^<<<<<<< /gm)).toHaveLength(2);
	await t.cleanup();
});

test('a setting deleted on one device and changed on another keeps the change', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.settings.set('theme', 'light'));
	await t.settle(t.alice, t.bob);
	t.bob.transport.setOnline(false);
	void t.bob.repo.settings.set('theme', 'dark');
	await landed(t.alice, t.alice.repo.settings.set('theme', undefined));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	for (const repo of [t.alice.repo, t.bob.repo]) expect((await repo.settings.get())?.fields).toEqual({ theme: 'dark' });
	await t.cleanup();
});

test('an edit made before a move follows it', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'draft' }, { body: 'one\n' }));
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.write({ stem: 'draft' }, { body: 'one\ntwo\n' });
	await landed(t.alice, t.alice.repo.notes.move({ stem: 'draft' }, { stem: 'final' }));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	for (const repo of [t.alice.repo, t.bob.repo]) {
		expect(await text(repo, 'final')).toBe('one\ntwo\n');
		expect(await text(repo, 'draft')).toBeNull();
	}
	await t.cleanup();
});

// ============================================================================
// A path is one of a note's fields: the current one wins
// ============================================================================

test('two renames of one note made offline: the one that landed first wins, and the other device is told', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'trip' }, { body: 'Trip\n' }));
	await t.settle(t.alice, t.bob);
	t.alice.transport.setOnline(false);
	t.bob.transport.setOnline(false);
	expectOk(await t.alice.repo.notes.move({ stem: 'trip' }, { stem: 'kyoto' }));
	expectOk(await t.bob.repo.notes.move({ stem: 'trip' }, { stem: 'japan' }));
	// An edit Bob makes to the renamed note before he hears back follows it.
	expectOk(await t.bob.repo.notes.append({ stem: 'japan' }, 'Temples.\n'));
	t.alice.transport.setOnline(true);
	await t.alice.repo.flush();
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	for (const repo of [t.alice.repo, t.bob.repo]) {
		expect(await text(repo, 'kyoto')).toBe('Trip\nTemples.\n');
		expect(await repo.notes.list()).toHaveLength(1);
	}
	expect(await notices(t.bob.repo)).toEqual([
		{ kind: 'refused', path: 'notes/kyoto.md', reason: "renamed to 'kyoto' elsewhere; your rename to 'japan' wasn't applied", kept: null },
	]);
	expect(await notices(t.alice.repo)).toEqual([]);
	await t.cleanup();
});

test('a rename made offline onto a name another note took keeps that note there, and this one where it was', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'final' }, { body: 'one\n' }));
	await t.settle(t.alice, t.bob);
	t.bob.transport.setOnline(false);
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'taken' }, { body: 'mine\n' }));
	expectOk(await t.bob.repo.notes.move({ stem: 'final' }, { stem: 'taken' }));
	// An edit Bob makes to the moved note before he hears back stays with it.
	expectOk(await t.bob.repo.notes.append({ stem: 'taken' }, 'two\n'));
	expect(await text(t.bob.repo, 'taken')).toBe('one\ntwo\n');
	expect(await text(t.bob.repo, 'final')).toBeNull();
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	for (const repo of [t.alice.repo, t.bob.repo]) {
		expect(await text(repo, 'final')).toBe('one\ntwo\n');
		expect(await text(repo, 'taken')).toBe('mine\n');
		expect(await repo.notes.list()).toHaveLength(2);
	}
	expect(await notices(t.bob.repo)).toEqual([
		{ kind: 'refused', path: 'notes/final.md', reason: "'taken' is taken; your note is still 'final'", kept: null },
	]);
	await t.cleanup();
});

test('a rename alone shows the server again where the note stays, with nothing left unsent', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'final' }, { body: 'one\n' }));
	await t.settle(t.alice, t.bob);
	t.bob.transport.setOnline(false);
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'taken' }, { body: 'mine\n' }));
	expectOk(await t.bob.repo.notes.move({ stem: 'final' }, { stem: 'taken' }));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	expect(await text(t.bob.repo, 'final')).toBe('one\n');
	expect(await text(t.bob.repo, 'taken')).toBe('mine\n');
	expect(await t.bob.repo.query('SELECT count(*) AS n FROM "epicenter/files" WHERE text IS NOT synced')).toEqual([{ n: 0 }]);
	await t.cleanup();
});

test('a send renaming a note renamed since it was sent is refused, and changes nothing', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'trip' }, { body: 'Trip\n' }));
	const agent = t.gated('agent-1', 'claude');
	await agent.repo.flush();
	t.alice.transport.setOnline(false);
	expectOk(await t.alice.repo.notes.move({ stem: 'trip' }, { stem: 'kyoto' }));
	agent.hold();
	const sent = agent.repo.send((b) => b.notes.move({ stem: 'trip' }, { stem: 'japan' }));
	t.alice.transport.setOnline(true);
	await t.alice.repo.flush();
	agent.release();
	expect(expectOk(await sent)).toMatchObject({ kind: 'refused', path: 'notes/trip.md', reason: 'the note was renamed elsewhere' });
	await agent.repo.flush();
	expect(await text(agent.repo, 'kyoto')).toBe('Trip\n');
	expect(await agent.repo.notes.list()).toHaveLength(1);
	expect(await t.server.read('notes/japan.md')).toBeNull();
	await t.cleanup();
});

test('a send renaming a note onto a name another note took meanwhile is refused, and changes nothing', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'final' }, { body: 'one\n' }));
	const agent = t.gated('agent-1', 'claude');
	await agent.repo.flush();
	t.alice.transport.setOnline(false);
	expectOk(await t.alice.repo.notes.create({ stem: 'taken' }, { body: 'mine\n' }));
	agent.hold();
	const sent = agent.repo.send((b) => b.notes.move({ stem: 'final' }, { stem: 'taken' }));
	t.alice.transport.setOnline(true);
	await t.alice.repo.flush();
	agent.release();
	expect(expectOk(await sent)).toMatchObject({ kind: 'refused', path: 'notes/taken.md', reason: 'the destination is taken' });
	await agent.repo.flush();
	expect(await text(agent.repo, 'final')).toBe('one\n');
	expect(await text(agent.repo, 'taken')).toBe('mine\n');
	await t.cleanup();
});

test('for people, a delete versus an edit keeps the edit', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'keep' }, { body: 'v1\n' }));
	t.alice.transport.setOnline(false);
	const deleted = t.alice.repo.notes.delete({ stem: 'keep' });
	expect(await text(t.alice.repo, 'keep')).toBeNull();
	await landed(t.bob, t.bob.repo.notes.write({ stem: 'keep' }, { body: 'v2\n' }));
	t.alice.transport.setOnline(true);
	await landed(t.alice, deleted);
	expect(await text(t.alice.repo, 'keep')).toBe('v2\n');
	expect(await text(t.bob.repo, 'keep')).toBe('v2\n');
	await t.cleanup();
});

test('a note brought back by an unseen edit takes later unseen edits too (bug A)', async () => {
	const t = await setup();
	const carol = t.device('carol-tablet', 'carol');
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'n' }, { body: 'v1\n' }));
	await t.settle(t.alice, t.bob, carol);
	t.bob.transport.setOnline(false);
	carol.transport.setOnline(false);
	void t.bob.repo.notes.write({ stem: 'n' }, { body: 'v1 bob\n' });
	void carol.repo.notes.write({ stem: 'n' }, { body: 'carol v1\n' });
	await landed(t.alice, t.alice.repo.notes.delete({ stem: 'n' }));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	carol.transport.setOnline(true);
	await t.settle(carol, t.alice, t.bob);
	for (const repo of [t.alice.repo, t.bob.repo, carol.repo]) {
		expect(await text(repo, 'n')).toBe('carol v1 bob\n');
		expect(await repo.notes.list()).toHaveLength(1);
	}
	await t.cleanup();
});

test('an offline append to a note deleted and re-created across commits becomes a sibling (bug B)', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'log' }, { body: 'old log\n' }));
	await t.settle(t.alice, t.bob);
	t.bob.transport.setOnline(false);
	const appended = t.bob.repo.notes.append({ stem: 'log' }, 'bob\n');
	await landed(t.alice, t.alice.repo.notes.delete({ stem: 'log' }));
	expectOk(await t.server.commit());
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'log' }, { body: 'new log\n' }));
	t.advance(120_000);
	expectOk(await t.server.tick());
	t.bob.transport.setOnline(true);
	await landed(t.bob, appended);
	expect(await notices(t.bob.repo)).toEqual([
		{
			kind: 'relocated',
			path: 'notes/log (bob, 2026-10-28).md',
			reason: 'the file was deleted and its path reused, so this change to notes/log.md was saved here',
			kept: null,
		},
	]);
	await t.settle(t.alice, t.bob);
	for (const repo of [t.alice.repo, t.bob.repo]) {
		expect(await text(repo, 'log')).toBe('new log\n');
		expect(await text(repo, 'log (bob, 2026-10-28)')).toBe('old log\nbob\n');
	}
	await t.cleanup();
});

test('settings set on two devices merges by key', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.settings.set('theme', 'light'));
	t.alice.transport.setOnline(false);
	t.bob.transport.setOnline(false);
	void t.alice.repo.settings.set('theme', 'dark');
	void t.bob.repo.settings.set('font', 'serif');
	t.alice.transport.setOnline(true);
	t.bob.transport.setOnline(true);
	await t.settle(t.alice, t.bob);
	for (const repo of [t.alice.repo, t.bob.repo])
		expect(await repo.settings.get()).toMatchObject({ valid: true, fields: { theme: 'dark', font: 'serif' } });
	expect(await t.alice.repo.query('SELECT theme, font FROM settings')).toEqual([{ theme: 'dark', font: 'serif' }]);
	await t.cleanup();
});

test('a field both devices set keeps the current value, and the device whose value was kept out is told', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'day' }, { fields: { weather: 'rain' } }));
	await t.settle(t.alice, t.bob);
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.set({ stem: 'day' }, 'weather', 'sun');
	await landed(t.alice, t.alice.repo.notes.set({ stem: 'day' }, 'weather', 'snow'));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	for (const repo of [t.alice.repo, t.bob.repo]) expect((await repo.notes.get({ stem: 'day' }))?.fields).toEqual({ weather: 'snow' });
	expect(await notices(t.bob.repo)).toEqual([
		{ kind: 'refused', path: 'notes/day.md', reason: "'weather' was changed to 'snow' elsewhere; your 'sun' wasn't applied", kept: null },
	]);
	expect(await notices(t.alice.repo)).toEqual([]);
	await t.cleanup();
});

test('appends from two devices keep both, in server order', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'log' }, { body: 'log\n' }));
	t.alice.transport.setOnline(false);
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.append({ stem: 'log' }, 'bob\n');
	void t.alice.repo.notes.append({ stem: 'log' }, 'alice\n');
	t.alice.transport.setOnline(true);
	await t.alice.repo.flush();
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	expect(await text(t.alice.repo, 'log')).toBe('log\nalice\nbob\n');
	expect(await text(t.bob.repo, 'log')).toBe('log\nalice\nbob\n');
	await t.cleanup();
});

test('a batch whose reply was lost is retried and returns its recorded outcome', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'once' }, { body: 'x\n' }));
	t.alice.transport.dropNextReply();
	const appended = t.alice.repo.notes.append({ stem: 'once' }, 'y\n');
	await t.alice.repo.flush();
	expect(t.server.sequence()).toBe(2);
	t.alice.transport.setOnline(true);
	await landed(t.alice, appended);
	expect(await t.server.read('notes/once.md')).toBe('x\ny\n');
	expect(await text(t.alice.repo, 'once')).toBe('x\ny\n');
	expect(t.server.sequence()).toBe(2);
	await t.cleanup();
});

test('a retry whose reply was lost and whose receipt left with its commit settles as applied', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'once' }, { body: 'x\n' }));
	t.alice.transport.dropNextReply();
	const appended = t.alice.repo.notes.append({ stem: 'once' }, 'y\n');
	await t.alice.repo.flush();
	t.advance(8 * 24 * 3600e3);
	expectOk(await t.server.tick());
	t.alice.transport.setOnline(true);
	await landed(t.alice, appended);
	expect(await notices(t.alice.repo)).toEqual([]);
	expect(await text(t.alice.repo, 'once')).toBe('x\ny\n');
	expect(await t.server.read('notes/once.md')).toBe('x\ny\n');
	expect(await t.alice.repo.query('SELECT count(*) AS n FROM "epicenter/outbox"')).toEqual([{ n: 0 }]);
	await t.cleanup();
});

test('a batch with a move in it is one server batch, all or nothing', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'a' }, { body: 'A\n' }));
	await landed(
		t.alice,
		t.alice.repo.batch((b) => {
			b.notes.create({ stem: 'b' }, { body: 'B\n' });
			b.notes.create({ stem: 'c' }, { body: 'C\n' });
			b.notes.move({ stem: 'a' }, { stem: 'moved' });
			b.notes.append({ stem: 'b' }, 'more\n');
		}),
	);
	// The creates, the move and the append: one batch after the first.
	expect(t.server.sequence()).toBe(2);
	expect(await text(t.bob.repo, 'moved')).toBe('A\n');
	expect(await text(t.bob.repo, 'b')).toBe('B\nmore\n');
	await t.cleanup();
});

test('a base the server no longer has round-trips through need-base', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'n' }, { body: 'one\ntwo\nthree\n' }));
	expectOk(await t.server.commit());
	await landed(t.alice, t.alice.repo.notes.write({ stem: 'n' }, { body: 'one\ntwo\nthree\nfour\n' }));
	t.bob.transport.setOnline(false);
	await landed(t.alice, t.alice.repo.notes.write({ stem: 'n' }, { body: 'ONE\ntwo\nthree\nfour\n' }));
	// Bob's base (with "four") was replaced in the overlay before this commit, so it is in neither.
	expectOk(await t.server.commit());
	const edit = t.bob.repo.notes.write({ stem: 'n' }, { body: 'one\ntwo\nTHREE\nfour\n' });
	t.bob.transport.setOnline(true);
	await landed(t.bob, edit);
	expect(await notices(t.bob.repo)).toEqual([]);
	await t.settle(t.alice, t.bob);
	expect(await text(t.alice.repo, 'n')).toBe('ONE\ntwo\nTHREE\nfour\n');
	expect(await text(t.bob.repo, 'n')).toBe('ONE\ntwo\nTHREE\nfour\n');
	await t.cleanup();
});

test('a device offline across many commits follows a move made ten commits ago', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'draft' }, { body: 'one\n' }));
	await t.settle(t.alice, t.bob);
	t.bob.transport.setOnline(false);
	const edit = t.bob.repo.notes.append({ stem: 'draft' }, 'two\n');
	await landed(t.alice, t.alice.repo.notes.move({ stem: 'draft' }, { stem: 'final' }));
	expectOk(await t.server.commit());
	for (let k = 0; k < 10; k++) {
		await landed(t.alice, t.alice.repo.notes.create({ stem: `other ${k}` }, { body: `${k}\n` }));
		t.advance(30 * 24 * 3600e3);
		expectOk(await t.server.tick());
	}
	expect(t.server.overlaySize()).toBe(0);
	t.bob.transport.setOnline(true);
	await landed(t.bob, edit);
	// Following a move is no surprise to tell anyone about.
	expect(await notices(t.bob.repo)).toEqual([]);
	await t.settle(t.alice, t.bob);
	for (const repo of [t.alice.repo, t.bob.repo]) {
		expect(await text(repo, 'final')).toBe('one\ntwo\n');
		expect(await text(repo, 'draft')).toBeNull();
		expect(await repo.notes.list()).toHaveLength(11);
	}
	await t.cleanup();
});

test('an edit to a note deleted and replaced meanwhile becomes a sibling, and the new note stays', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'plan' }, { body: 'old plan\n' }));
	await t.settle(t.alice, t.bob);
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.write({ stem: 'plan' }, { body: 'old plan\nbob one\n' });
	const second = t.bob.repo.notes.append({ stem: 'plan' }, 'bob two\n');
	await landed(t.alice, t.alice.repo.notes.delete({ stem: 'plan' }));
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'plan' }, { body: 'a different plan\n' }));
	t.bob.transport.setOnline(true);
	// Both of Bob's batches still name the old path, and both land in one sibling; Bob is told once.
	await landed(t.bob, second);
	expect(await notices(t.bob.repo)).toMatchObject([{ kind: 'relocated', path: 'notes/plan (bob, 2026-10-28).md' }]);
	await t.settle(t.alice, t.bob);
	for (const repo of [t.alice.repo, t.bob.repo]) {
		expect(await text(repo, 'plan')).toBe('a different plan\n');
		expect(await text(repo, 'plan (bob, 2026-10-28)')).toBe('old plan\nbob one\nbob two\n');
		expect(await repo.notes.list()).toHaveLength(2);
	}
	await t.cleanup();
});

test('a note and its blob land in one batch', async () => {
	const t = await setup();
	const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
	await landed(
		t.alice,
		t.alice.repo.batch((b) => {
			b.notes.create({ stem: 'beach' }, { body: '![](beach/photo.png)\n' });
			b.photos.put({ stem: 'beach', file: 'photo.png' }, bytes, { type: 'image/png' });
		}),
	);
	// One batch, so one server sequence holds both.
	expect(t.server.sequence()).toBe(1);
	await t.bob.repo.flush();
	expect(await text(t.bob.repo, 'beach')).toBe('![](beach/photo.png)\n');
	expect(await t.bob.repo.photos.list()).toMatchObject([{ path: 'notes/beach/photo.png', size: 7 }]);
	expect(await t.bob.repo.photos.get({ stem: 'beach', file: 'photo.png' })).toEqual(bytes);
	const refused = expectErr(await t.alice.repo.photos.put({ stem: 'x', file: 'a.gif' }, bytes, { type: 'image/gif' }));
	expect(refused.name).toBe('BlobRefused');
	await t.cleanup();
});

test('the overlay clears after a commit, and the commit carries the sequence', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'a' }, { body: 'A\n' }));
	await landed(t.bob, t.bob.repo.notes.create({ stem: 'b' }, { body: 'B\n' }));
	expect(t.server.overlaySize()).toBe(2);
	expectOk(await t.server.commit());
	expect(t.server.overlaySize()).toBe(0);
	const head = await t.git.readCommit((await t.git.readRef(MAIN)) ?? '');
	expect(sequenceOf(head?.message ?? '')).toBe(t.server.sequence());
	expect(head?.message).toContain('Co-authored-by: bob');
	// A fresh device opens from Git alone.
	const carol = t.device('carol-tablet', 'carol');
	await carol.repo.flush();
	expect((await carol.repo.notes.list()).map((note) => note.text)).toEqual(['A\n', 'B\n']);
	await t.cleanup();
});

test('an agent push that overlaps is refused, and a clean one lands with its commit as a parent', async () => {
	const t = await setup();
	await landed(t.alice, t.alice.repo.notes.create({ stem: 'plan' }, { body: 'one\ntwo\nthree\n' }));
	expectOk(await t.server.commit());
	const base = (await t.git.readRef(MAIN)) ?? '';
	const commitWith = async (body: string) => {
		const info = await t.git.readCommit(base);
		const tree = await t.git.readTree(info?.tree ?? '');
		tree.set('notes/plan.md', { mode: '100644', oid: await t.git.writeBlob(new TextEncoder().encode(body)) });
		return t.git.writeCommit({
			tree: await t.git.writeTree(tree),
			parents: [base],
			message: 'agent edit\n',
			author: { name: 'Claude', email: 'agent@epicenter.invalid' },
			at: new Date(),
		});
	};
	await landed(t.alice, t.alice.repo.notes.write({ stem: 'plan' }, { body: 'one\nTWO\nthree\n' }));
	const overlapping = await commitWith('one\n2\nthree\n');
	expect(expectOk(await t.server.receivePush({ commit: overlapping, user: 'claude' }))).toMatchObject({ kind: 'refused', path: 'notes/plan.md' });

	const clean = await commitWith('one\ntwo\nthree\nfour\n');
	const pushed = expectOk(await t.server.receivePush({ commit: clean, user: 'claude' }));
	expect(pushed.kind).toBe('applied');
	expect((await t.git.readCommit((await t.git.readRef(MAIN)) ?? ''))?.parents).toContain(clean);
	expect(await text(t.bob.repo, 'plan')).toBe('one\nTWO\nthree\nfour\n');
	await t.cleanup();
});
