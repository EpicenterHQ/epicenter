/**
 * End-to-End Repository Tests
 *
 * Two devices (and sometimes an agent) run the real engine on `bun:sqlite`,
 * talk to one real server through the in-process transport, and the server
 * commits to a real bare Git repository. These are the scenarios ADR-0692's
 * design rests on, observed from the app API.
 *
 * Key behaviors:
 * - Edits appear on other devices; offline edits merge on reconnect
 * - Overlaps become marker blocks for people and refusals for agents
 * - Creates at one path merge; moves carry stale edits; taken paths refuse
 * - Delete versus edit keeps the edit; root-record sets merge by key; appends keep server order
 * - Retries, need-base and expiry; a note and its blob land together
 * - Commits clear the overlay with the right sequence; agent pushes merge or refuse
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
import { openRepository } from './engine/engine.js';
import { createMemoryBlobStore } from './engine/ports.js';
import type { OnOverlap } from './policy.js';
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
	const device = (name: string, user: string, onOverlap: OnOverlap = 'mark') => {
		const transport = createInProcessTransport(server, { user, onOverlap });
		const repo = openRepository({ app, driver: openBunSqlite(), transport, device: name, blobs });
		return { repo, transport };
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

const text = (repo: { notes: { get(p: { stem: string }): { text: string } | null } }, stem: string) =>
	repo.notes.get({ stem })?.text ?? null;

test('an edit appears on the other device, and its live query re-runs', async () => {
	const t = await setup();
	const seen: unknown[] = [];
	t.bob.repo.live('SELECT stem, title FROM notes', [], (rows) => seen.push(rows));
	const settled = expectOk(await t.alice.repo.notes.create({ stem: 'trip' }, { fields: { title: 'Trip' }, body: 'Pack.\n' }));
	expect(settled).toMatchObject({ kind: 'applied', seq: 1 });
	expect(t.bob.repo.notes.get({ stem: 'trip' })).toMatchObject({ valid: true, fields: { title: 'Trip' }, body: 'Pack.\n', params: { stem: 'trip' } });
	expect(seen).toEqual([[], [{ stem: 'trip', title: 'Trip' }]]);
	await t.cleanup();
});

test('an offline edit on each device merges on reconnect', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.notes.create({ stem: 'list' }, { body: 'a\nb\nc\n' }));
	t.alice.transport.setOnline(false);
	t.bob.transport.setOnline(false);
	void t.alice.repo.notes.write({ stem: 'list' }, { body: 'A\nb\nc\n' });
	void t.bob.repo.notes.write({ stem: 'list' }, { body: 'a\nb\nC\n' });
	expect(text(t.alice.repo, 'list')).toBe('A\nb\nc\n');
	t.alice.transport.setOnline(true);
	t.bob.transport.setOnline(true);
	await t.settle(t.alice, t.bob);
	expect(text(t.alice.repo, 'list')).toBe('A\nb\nC\n');
	expect(text(t.bob.repo, 'list')).toBe('A\nb\nC\n');
	await t.cleanup();
});

test('a true overlap becomes a marker block for people and a refusal for an agent', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.notes.create({ stem: 'pet' }, { body: 'cat\n' }));
	const agent = t.device('agent-1', 'claude', 'refuse');
	await agent.repo.flush();
	t.bob.transport.setOnline(false);
	agent.transport.setOnline(false);
	void t.bob.repo.notes.write({ stem: 'pet' }, { body: 'coat\n' });
	const agentWrite = agent.repo.notes.write({ stem: 'pet' }, { body: 'cut\n' });
	expectOk(await t.alice.repo.notes.write({ stem: 'pet' }, { body: 'cart\n' }));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	const marked = text(t.alice.repo, 'pet') ?? '';
	expect(marked).toContain('<<<<<<< alice');
	expect(marked).toContain('cart\n||||||| base\ncat\n=======\ncoat\n>>>>>>> bob');
	expect(text(t.bob.repo, 'pet')).toBe(marked);

	agent.transport.setOnline(true);
	expect(expectOk(await agentWrite)).toMatchObject({ kind: 'refused', path: 'notes/pet.md' });
	expect(text(agent.repo, 'pet')).toBe(marked);
	expect(agent.repo.offlineCopies()).toMatchObject([{ reason: 'refused', changes: [{ path: 'notes/pet.md', text: 'cut\n' }] }]);
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
	expect(text(t.alice.repo, 'daily')).toBe(expected);
	expect(text(t.bob.repo, 'daily')).toBe(expected);
	await t.cleanup();
});

test('an overlap touching an existing conflict block keeps both sides as separate blocks', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.notes.create({ stem: 'pet' }, { body: 'intro\ncat\nend\n' }));
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.write({ stem: 'pet' }, { body: 'intro\ncoat\nend\n' });
	expectOk(await t.alice.repo.notes.write({ stem: 'pet' }, { body: 'intro\ncart\nend\n' }));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	const blocked = text(t.alice.repo, 'pet') ?? '';
	expect(text(t.bob.repo, 'pet')).toBe(blocked);
	expect(blocked.match(/^<<<<<<< /gm)).toHaveLength(1);

	// Alice edits the intro and a line inside the block; Bob, offline, edits the
	// intro and resolves the block.
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.write({ stem: 'pet' }, { body: 'intro by bob\ncoat\nend\n' });
	expectOk(await t.alice.repo.notes.write({ stem: 'pet' }, { body: blocked.replace('intro', 'intro by alice').replace('cart', 'CART') }));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	const final = text(t.alice.repo, 'pet') ?? '';
	expect(text(t.bob.repo, 'pet')).toBe(final);
	for (const kept of ['intro by alice', 'CART', 'intro by bob\ncoat\n']) expect(final).toContain(kept);
	expect(final.match(/^<<<<<<< /gm)).toHaveLength(2);
	await t.cleanup();
});

test("two creates at one path are refused for a 'refuse' device", async () => {
	const t = await setup();
	const agent = t.device('agent-1', 'claude', 'refuse');
	await agent.repo.flush();
	agent.transport.setOnline(false);
	const created = agent.repo.notes.create({ stem: 'daily' }, { fields: { weather: 'rain' }, body: 'Agent\n' });
	expectOk(await t.alice.repo.notes.create({ stem: 'daily' }, { fields: { weather: 'sun' }, body: 'Alice\n' }));
	agent.transport.setOnline(true);
	expect(expectOk(await created)).toMatchObject({ kind: 'refused', path: 'notes/daily.md', reason: 'both sides created the file' });
	expect(await t.server.read('notes/daily.md')).toBe('---\nweather: sun\n---\nAlice\n');
	await t.cleanup();
});

test('a setting deleted on one device and changed on another keeps the change', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.settings.set('theme', 'light'));
	await t.settle(t.alice, t.bob);
	t.bob.transport.setOnline(false);
	void t.bob.repo.settings.set('theme', 'dark');
	expectOk(await t.alice.repo.settings.set('theme', undefined));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	for (const repo of [t.alice.repo, t.bob.repo]) expect(repo.settings.get()?.fields).toEqual({ theme: 'dark' });
	await t.cleanup();
});

test('an edit made before a move follows it, and a move onto a taken path is refused', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.notes.create({ stem: 'draft' }, { body: 'one\n' }));
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.write({ stem: 'draft' }, { body: 'one\ntwo\n' });
	expectOk(await t.alice.repo.notes.move({ stem: 'draft' }, { stem: 'final' }));
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	for (const repo of [t.alice.repo, t.bob.repo]) {
		expect(text(repo, 'final')).toBe('one\ntwo\n');
		expect(text(repo, 'draft')).toBeNull();
	}

	t.bob.transport.setOnline(false);
	expectOk(await t.alice.repo.notes.create({ stem: 'taken' }, { body: 'mine\n' }));
	const move = t.bob.repo.notes.move({ stem: 'final' }, { stem: 'taken' });
	t.bob.transport.setOnline(true);
	expect(expectOk(await move)).toMatchObject({ kind: 'refused', reason: 'the destination is taken' });
	expect(text(t.bob.repo, 'final')).toBe('one\ntwo\n');
	expect(text(t.bob.repo, 'taken')).toBe('mine\n');
	await t.cleanup();
});

test('for people, a delete versus an edit keeps the edit', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.notes.create({ stem: 'keep' }, { body: 'v1\n' }));
	t.alice.transport.setOnline(false);
	const deleted = t.alice.repo.notes.delete({ stem: 'keep' });
	expect(text(t.alice.repo, 'keep')).toBeNull();
	expectOk(await t.bob.repo.notes.write({ stem: 'keep' }, { body: 'v2\n' }));
	t.alice.transport.setOnline(true);
	expect(expectOk(await deleted)).toMatchObject({
		kind: 'applied',
		change: { overlaps: [{ unit: 'file', clash: 'deleted', settled: 'edit-kept' }] },
	});
	expect(text(t.alice.repo, 'keep')).toBe('v2\n');
	expect(text(t.bob.repo, 'keep')).toBe('v2\n');
	await t.cleanup();
});

test('settings set on two devices merges by key', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.settings.set('theme', 'light'));
	t.alice.transport.setOnline(false);
	t.bob.transport.setOnline(false);
	void t.alice.repo.settings.set('theme', 'dark');
	void t.bob.repo.settings.set('font', 'serif');
	t.alice.transport.setOnline(true);
	t.bob.transport.setOnline(true);
	await t.settle(t.alice, t.bob);
	for (const repo of [t.alice.repo, t.bob.repo])
		expect(repo.settings.get()).toMatchObject({ valid: true, fields: { theme: 'dark', font: 'serif' } });
	expect(t.alice.repo.query('SELECT theme, font FROM settings')).toEqual([{ theme: 'dark', font: 'serif' }]);
	await t.cleanup();
});

test('appends from two devices keep both, in server order', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.notes.create({ stem: 'log' }, { body: 'log\n' }));
	t.alice.transport.setOnline(false);
	t.bob.transport.setOnline(false);
	void t.bob.repo.notes.append({ stem: 'log' }, 'bob\n');
	void t.alice.repo.notes.append({ stem: 'log' }, 'alice\n');
	t.alice.transport.setOnline(true);
	await t.alice.repo.flush();
	t.bob.transport.setOnline(true);
	await t.settle(t.bob, t.alice);
	expect(text(t.alice.repo, 'log')).toBe('log\nalice\nbob\n');
	expect(text(t.bob.repo, 'log')).toBe('log\nalice\nbob\n');
	await t.cleanup();
});

test('a batch whose reply was lost is retried and returns its recorded outcome', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.notes.create({ stem: 'once' }, { body: 'x\n' }));
	t.alice.transport.dropNextReply();
	const appended = t.alice.repo.notes.append({ stem: 'once' }, 'y\n');
	await t.alice.repo.flush();
	expect(t.server.sequence()).toBe(2);
	t.alice.transport.setOnline(true);
	expect(expectOk(await appended)).toMatchObject({ kind: 'applied', seq: 2 });
	expect(await t.server.read('notes/once.md')).toBe('x\ny\n');
	expect(text(t.alice.repo, 'once')).toBe('x\ny\n');
	expect(t.server.sequence()).toBe(2);
	await t.cleanup();
});

test('a base the server no longer has round-trips through need-base', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.notes.create({ stem: 'n' }, { body: 'one\ntwo\nthree\n' }));
	expectOk(await t.server.commit());
	expectOk(await t.alice.repo.notes.write({ stem: 'n' }, { body: 'one\ntwo\nthree\nfour\n' }));
	t.bob.transport.setOnline(false);
	expectOk(await t.alice.repo.notes.write({ stem: 'n' }, { body: 'ONE\ntwo\nthree\nfour\n' }));
	// Bob's base (with "four") was replaced in the overlay before this commit, so it is in neither.
	expectOk(await t.server.commit());
	const edit = t.bob.repo.notes.write({ stem: 'n' }, { body: 'one\ntwo\nTHREE\nfour\n' });
	t.bob.transport.setOnline(true);
	expect(expectOk(await edit).kind).toBe('applied');
	await t.settle(t.alice, t.bob);
	expect(text(t.alice.repo, 'n')).toBe('ONE\ntwo\nTHREE\nfour\n');
	expect(text(t.bob.repo, 'n')).toBe('ONE\ntwo\nTHREE\nfour\n');
	await t.cleanup();
});

test('an edit offline past the window is expired and kept as an offline copy', async () => {
	const t = await setup({ windowMs: 60_000 });
	expectOk(await t.alice.repo.notes.create({ stem: 'old' }, { body: 'base\n' }));
	t.bob.transport.setOnline(false);
	const edit = t.bob.repo.notes.write({ stem: 'old' }, { body: 'bob offline\n' });
	expectOk(await t.alice.repo.notes.write({ stem: 'old' }, { body: 'alice online\n' }));
	t.advance(120_000);
	expectOk(await t.server.tick());
	t.bob.transport.setOnline(true);
	expect(expectOk(await edit)).toMatchObject({ kind: 'expired', paths: ['notes/old.md'] });
	expect(text(t.bob.repo, 'old')).toBe('alice online\n');
	expect(t.bob.repo.offlineCopies()).toEqual([{ n: 1, reason: 'expired', changes: [{ path: 'notes/old.md', text: 'bob offline\n' }] }]);
	await t.cleanup();
});

test('a note and its blob land in one batch', async () => {
	const t = await setup();
	const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
	const settled = expectOk(
		await t.alice.repo.batch((b) => {
			b.notes.create({ stem: 'beach' }, { body: '![](beach/photo.png)\n' });
			b.photos.put({ stem: 'beach', file: 'photo.png' }, bytes, { type: 'image/png' });
		}),
	);
	expect(settled.map((s) => s.kind)).toEqual(['applied', 'applied']);
	expect(new Set(settled.map((s) => (s.kind === 'applied' ? s.seq : 0)))).toEqual(new Set([1]));
	expect(text(t.bob.repo, 'beach')).toBe('![](beach/photo.png)\n');
	expect(t.bob.repo.photos.list()).toMatchObject([{ path: 'notes/beach/photo.png', size: 7 }]);
	expect(await t.bob.repo.photos.get({ stem: 'beach', file: 'photo.png' })).toEqual(bytes);
	const refused = expectErr(await t.alice.repo.photos.put({ stem: 'x', file: 'a.gif' }, bytes, { type: 'image/gif' }));
	expect(refused.name).toBe('BlobRefused');
	await t.cleanup();
});

test('the overlay clears after a commit, and the commit carries the sequence', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.notes.create({ stem: 'a' }, { body: 'A\n' }));
	expectOk(await t.bob.repo.notes.create({ stem: 'b' }, { body: 'B\n' }));
	expect(t.server.overlaySize()).toBe(2);
	expectOk(await t.server.commit());
	expect(t.server.overlaySize()).toBe(0);
	const head = await t.git.readCommit((await t.git.readRef(MAIN)) ?? '');
	expect(sequenceOf(head?.message ?? '')).toBe(t.server.sequence());
	expect(head?.message).toContain('Co-authored-by: bob');
	// A fresh device opens from Git alone.
	const carol = t.device('carol-tablet', 'carol');
	await carol.repo.flush();
	expect(carol.repo.notes.list().map((note) => note.text)).toEqual(['A\n', 'B\n']);
	await t.cleanup();
});

test('an agent push that overlaps is refused, and a clean one lands with its commit as a parent', async () => {
	const t = await setup();
	expectOk(await t.alice.repo.notes.create({ stem: 'plan' }, { body: 'one\ntwo\nthree\n' }));
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
	expectOk(await t.alice.repo.notes.write({ stem: 'plan' }, { body: 'one\nTWO\nthree\n' }));
	const overlapping = await commitWith('one\n2\nthree\n');
	expect(expectOk(await t.server.receivePush({ commit: overlapping, user: 'claude' }))).toMatchObject({ kind: 'refused', path: 'notes/plan.md' });

	const clean = await commitWith('one\ntwo\nthree\nfour\n');
	const landed = expectOk(await t.server.receivePush({ commit: clean, user: 'claude' }));
	expect(landed.kind).toBe('applied');
	expect((await t.git.readCommit((await t.git.readRef(MAIN)) ?? ''))?.parents).toContain(clean);
	expect(text(t.bob.repo, 'plan')).toBe('one\nTWO\nthree\nfour\n');
	await t.cleanup();
});
