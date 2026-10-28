/**
 * Repository Server Tests
 *
 * The server is where ordering, merging and durability meet, so these tests
 * drive it directly with batches, a real `bun:sqlite` overlay and a real bare
 * Git repository. Device-level behavior is covered end to end in
 * `e2e.test.ts`; these pin the server's own contract.
 *
 * Key behaviors:
 * - `'mark'` overlaps become marker blocks in server order; `'refuse'` refuses the batch
 * - A retried batch returns its recorded outcome; a gap is refused
 * - An unknown base answers need-base, and the resent base applies
 * - Bases older than the window answer expired unless the file is unchanged
 * - Edits follow moves; a move onto a taken path is refused
 * - Commits carry `Epicenter-Seq`, clear the overlay and land on a timer
 * - Agent pushes: overlap and bad files refused, a clean push is a merge parent
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { openBunGitStore } from '../bun/git.js';
import { openBunSqlite } from '../bun/sqlite.js';
import { gitBlobHash } from '../hash.js';
import type { Batch, Broadcast, Change } from '../protocol.js';
import { type GitStore, MAIN, sequenceOf } from './git-store.js';
import { createRepositoryServer, type ServerOptions } from './server.js';

const encoder = new TextEncoder();

async function setup(options: Partial<ServerOptions> = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'repository-server-'));
	const git = await openBunGitStore(join(dir, 'repo.git'));
	let clock = Date.parse('2026-10-28T12:00:00Z');
	const server = createRepositoryServer({
		driver: openBunSqlite(),
		git,
		now: () => clock,
		...options,
	});
	const heard: Broadcast[] = [];
	const alice = server.connect({ device: 'alice-laptop', user: 'alice', onOverlap: 'mark' });
	const bob = server.connect({ device: 'bob-phone', user: 'bob', onOverlap: 'mark', onBroadcast: (b) => heard.push(b) });
	const agent = server.connect({ device: 'agent-1', user: 'claude', onOverlap: 'refuse' });
	const numbers = new Map<string, number>();
	const batch = (device: string, seq: number, ...changes: Change[]): Batch => {
		const n = (numbers.get(device) ?? 0) + 1;
		numbers.set(device, n);
		return { device, n, seq, changes };
	};
	const write = (path: string, base: string | null, text: string | null): Change => ({
		kind: 'write',
		path,
		base: base === null ? null : { hash: gitBlobHash(base), text: base },
		text,
	});
	return {
		server,
		git,
		alice,
		bob,
		agent,
		heard,
		batch,
		write,
		advance: (ms: number) => {
			clock += ms;
		},
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

async function seed(t: Awaited<ReturnType<typeof setup>>, path: string, text: string) {
	const outcome = await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write(path, null, text)));
	expect(outcome.kind).toBe('applied');
	return t.server.sequence();
}

// ============================================================================
// Batches and policies
// ============================================================================

describe('batches', () => {
	test('a create applies, is readable, and is broadcast to other devices', async () => {
		const t = await setup();
		const outcome = await t.alice.push(t.batch('alice-laptop', 0, t.write('notes/a.md', null, 'Hello\n')));
		expect(outcome).toMatchObject({ kind: 'applied', seq: 1, changes: [{ path: 'notes/a.md', at: 'notes/a.md', hash: gitBlobHash('Hello\n') }] });
		expect(await t.server.read('notes/a.md')).toBe('Hello\n');
		expect(t.heard).toEqual([{ seq: 1, device: 'alice-laptop', files: [{ path: 'notes/a.md', text: 'Hello\n', hash: gitBlobHash('Hello\n') }], moves: [] }]);
		await t.cleanup();
	});

	test("people's true overlap becomes a marker block in server order", async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', 'cat\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', 'cat\n', 'cart\n')));
		const outcome = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'cat\n', 'coat\n')));
		const text = await t.server.read('notes/a.md');
		expect(text).toBe(
			'<<<<<<< alice 2026-10-28T12:00:00.000Z seq 2\ncart\n||||||| base\ncat\n=======\ncoat\n>>>>>>> bob 2026-10-28T12:00:00.000Z seq 3\n',
		);
		expect(outcome).toMatchObject({ kind: 'applied', changes: [{ text, overlaps: [{ current: 'cart', incoming: 'coat' }] }] });
		await t.cleanup();
	});

	test("a 'refuse' peer's overlap is refused and changes nothing", async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', 'cat\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', 'cat\n', 'cart\n')));
		const outcome = await t.agent.push(
			t.batch('agent-1', seq, t.write('notes/b.md', null, 'B\n'), t.write('notes/a.md', 'cat\n', 'coat\n')),
		);
		expect(outcome).toMatchObject({ kind: 'refused', path: 'notes/a.md', overlaps: [{ current: 'cart', incoming: 'coat' }] });
		expect(await t.server.read('notes/b.md')).toBeNull();
		expect(t.server.sequence()).toBe(2);
		await t.cleanup();
	});

	test("a field both sides changed keeps current for 'mark' and refuses 'refuse'", async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', '---\nstatus: todo\n---\nx\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', '---\nstatus: todo\n---\nx\n', '---\nstatus: done\n---\nx\n')));
		const refused = await t.agent.push(
			t.batch('agent-1', seq, t.write('notes/a.md', '---\nstatus: todo\n---\nx\n', '---\nstatus: wontfix\n---\nx\n')),
		);
		expect(refused).toMatchObject({
			kind: 'refused',
			path: 'notes/a.md',
			reason: "the field 'status' changed on both sides",
			overlaps: [{ unit: 'field', key: 'status', base: 'todo', current: 'done', incoming: 'wontfix' }],
		});
		const marked = await t.bob.push(
			t.batch('bob-phone', seq, t.write('notes/a.md', '---\nstatus: todo\n---\nx\n', '---\nstatus: wontfix\n---\nx\n')),
		);
		expect(marked).toMatchObject({
			kind: 'applied',
			changes: [{ overlaps: [{ unit: 'field', key: 'status', current: 'done', incoming: 'wontfix', settled: 'current-kept' }] }],
		});
		expect(await t.server.read('notes/a.md')).toBe('---\nstatus: done\n---\nx\n');
		await t.cleanup();
	});

	test('a retried batch returns its recorded outcome without applying twice', async () => {
		const t = await setup();
		const batch = t.batch('alice-laptop', 0, { kind: 'write', path: 'log.md', base: null, text: 'one\n' });
		const first = await t.alice.push(batch);
		const again = await t.alice.push({ ...batch, changes: [{ kind: 'append', path: 'log.md', text: 'two\n' }] });
		expect(again).toEqual(first);
		expect(await t.server.read('log.md')).toBe('one\n');
		expect(await t.alice.push({ device: 'alice-laptop', n: 5, seq: 1, changes: [] })).toMatchObject({ kind: 'refused' });
		await t.cleanup();
	});

	test('an unknown base answers need-base, and resending it applies', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', 'one\ntwo\n');
		const unknown = 'one\ntwo\nthree\n';
		const change: Change = { kind: 'write', path: 'notes/a.md', base: { hash: gitBlobHash(unknown) }, text: 'one\ntwo\nthree\nfour\n' };
		const batch = t.batch('bob-phone', seq, change);
		expect(await t.bob.push(batch)).toEqual({ kind: 'need-base', paths: ['notes/a.md'] });
		const resent = { ...batch, changes: [{ ...change, base: { hash: gitBlobHash(unknown), text: unknown } }] };
		expect((await t.bob.push(resent)).kind).toBe('applied');
		expect(await t.server.read('notes/a.md')).toBe('one\ntwo\nfour\n');
		await t.cleanup();
	});

	test('a base older than the window is expired unless the file is unchanged', async () => {
		const t = await setup({ windowMs: 1000 });
		const seq = await seed(t, 'notes/a.md', 'a\n');
		await seed(t, 'notes/b.md', 'b\n');
		await t.alice.push(t.batch('alice-laptop', seq + 1, t.write('notes/a.md', 'a\n', 'a by alice\n')));
		t.advance(5000);
		const stale = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'a\n', 'a by bob\n')));
		expect(stale).toEqual({ kind: 'expired', paths: ['notes/a.md'] });
		const unchanged = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/b.md', 'b\n', 'b by bob\n')));
		expect(unchanged.kind).toBe('applied');
		await t.cleanup();
	});

	test('an edit follows a move, and a move onto a taken path is refused', async () => {
		const t = await setup();
		await seed(t, 'notes/a.md', 'A\n');
		const seq = await seed(t, 'notes/b.md', 'B\n');
		await t.alice.push(t.batch('alice-laptop', seq, { kind: 'move', from: 'notes/a.md', to: 'notes/renamed.md' }));
		const edit = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'A\n', 'A edited\n')));
		expect(edit).toMatchObject({ kind: 'applied', changes: [{ path: 'notes/a.md', at: 'notes/renamed.md', movedTo: 'notes/renamed.md' }] });
		expect(await t.server.read('notes/renamed.md')).toBe('A edited\n');
		expect(await t.server.read('notes/a.md')).toBeNull();
		const taken = await t.bob.push(t.batch('bob-phone', t.server.sequence(), { kind: 'move', from: 'notes/b.md', to: 'notes/renamed.md' }));
		expect(taken).toMatchObject({ kind: 'refused', path: 'notes/renamed.md', reason: 'the destination is taken' });
		await t.cleanup();
	});

	test('an edit to a deleted path that was reused is stale, not misapplied', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', 'old\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', 'old\n', null)));
		await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('notes/a.md', null, 'different note\n')));
		const edit = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'old\n', 'old edited\n')));
		expect(edit).toMatchObject({
			kind: 'applied',
			changes: [{ at: null, overlaps: [{ unit: 'path', clash: 'reused', relocatedTo: null, settled: 'dropped' }] }],
		});
		expect(await t.server.read('notes/a.md')).toBe('different note\n');
		await t.cleanup();
	});

	test('for people, a delete loses to an edit it had not seen', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', 'v1\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', 'v1\n', 'v2\n')));
		const outcome = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'v1\n', null)));
		expect(outcome).toMatchObject({
			kind: 'applied',
			changes: [{ at: 'notes/a.md', text: 'v2\n', overlaps: [{ unit: 'file', clash: 'deleted', side: 'incoming', settled: 'edit-kept' }] }],
		});
		expect(await t.server.read('notes/a.md')).toBe('v2\n');
		await t.cleanup();
	});
});

// ============================================================================
// Commits
// ============================================================================

async function mainCommit(git: GitStore) {
	const oid = await git.readRef(MAIN);
	return oid === null ? null : { oid, ...(await git.readCommit(oid)) };
}

describe('commits', () => {
	test('a commit carries the sequence, holds the files and clears the overlay', async () => {
		const t = await setup();
		await seed(t, 'notes/a.md', 'A\n');
		await seed(t, 'notes/b.md', 'B\n');
		expect(t.server.overlaySize()).toBe(2);
		const committed = expectOk(await t.server.commit());
		expect(committed?.seq).toBe(2);
		const head = await mainCommit(t.git);
		expect(sequenceOf(head?.message ?? '')).toBe(2);
		expect(head?.message).toContain('Co-authored-by: alice <alice@users.epicenter.invalid>');
		const tree = await t.git.readTree(head?.tree ?? '');
		expect([...tree.keys()].sort()).toEqual(['notes/a.md', 'notes/b.md']);
		expect(t.server.overlaySize()).toBe(0);
		expect(await t.server.read('notes/a.md')).toBe('A\n');
		await t.cleanup();
	});

	test('the overlay clears only up to what Git holds', async () => {
		const t = await setup();
		await seed(t, 'notes/a.md', 'A\n');
		expectOk(await t.server.commit());
		await seed(t, 'notes/b.md', 'B\n');
		expect(t.server.overlaySize()).toBe(1);
		expect(expectOk(await t.server.commit())?.seq).toBe(2);
		expect(expectOk(await t.server.commit())).toBeNull();
		await t.cleanup();
	});

	test('tick commits once the oldest change is a minute old', async () => {
		const t = await setup();
		await seed(t, 'notes/a.md', 'A\n');
		t.advance(30_000);
		expect(expectOk(await t.server.tick())).toBeNull();
		t.advance(30_000);
		expect(expectOk(await t.server.tick())?.seq).toBe(1);
		await t.cleanup();
	});

	test('commit-before-ack leaves nothing in the overlay after an acknowledgment', async () => {
		const t = await setup({ durability: 'commit-before-ack' });
		await seed(t, 'notes/a.md', 'A\n');
		expect(t.server.overlaySize()).toBe(0);
		expect(sequenceOf((await mainCommit(t.git))?.message ?? '')).toBe(1);
		await t.cleanup();
	});

	test('a committed base is found in Git by hash after the overlay clears', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', 'one\n');
		expectOk(await t.server.commit());
		const outcome = await t.bob.push(
			t.batch('bob-phone', seq, { kind: 'write', path: 'notes/a.md', base: { hash: gitBlobHash('one\n') }, text: 'one\ntwo\n' }),
		);
		expect(outcome.kind).toBe('applied');
		await t.cleanup();
	});
});

// ============================================================================
// Agent pushes
// ============================================================================

/** Make a commit on top of `parent` with `files` changed (null deletes). */
async function agentCommit(git: GitStore, parent: string, files: Record<string, string | Uint8Array | null>) {
	const info = await git.readCommit(parent);
	const tree = await git.readTree(info?.tree ?? '');
	for (const [path, content] of Object.entries(files)) {
		if (content === null) tree.delete(path);
		else tree.set(path, { mode: '100644', oid: await git.writeBlob(typeof content === 'string' ? encoder.encode(content) : content) });
	}
	return git.writeCommit({
		tree: await git.writeTree(tree),
		parents: [parent],
		message: 'agent work\n',
		author: { name: 'Claude', email: 'agent@epicenter.invalid' },
		at: new Date('2026-10-28T12:00:00Z'),
	});
}

describe('agent push', () => {
	async function cloned() {
		const t = await setup();
		await seed(t, 'notes/a.md', 'one\ntwo\nthree\n');
		await seed(t, 'notes/b.md', 'B\n');
		expectOk(await t.server.commit());
		const base = (await t.git.readRef(MAIN)) ?? '';
		return { ...t, base };
	}

	test('a clean push lands with the pushed commit as a parent', async () => {
		const t = await cloned();
		await t.alice.push(t.batch('alice-laptop', 2, t.write('notes/a.md', 'one\ntwo\nthree\n', 'ONE\ntwo\nthree\n')));
		const pushed = await agentCommit(t.git, t.base, { 'notes/a.md': 'one\ntwo\nTHREE\n', 'notes/c.md': 'C\n' });
		const outcome = expectOk(await t.server.receivePush({ commit: pushed, user: 'claude' }));
		expect(outcome.kind).toBe('applied');
		const head = await mainCommit(t.git);
		expect(head?.parents).toContain(pushed);
		expect(await t.server.read('notes/a.md')).toBe('ONE\ntwo\nTHREE\n');
		expect(await t.server.read('notes/c.md')).toBe('C\n');
		expect(t.heard.at(-1)?.device).toBe('git-push');
		await t.cleanup();
	});

	test('an overlapping push is refused after the overlay is committed', async () => {
		const t = await cloned();
		await t.alice.push(t.batch('alice-laptop', 2, t.write('notes/a.md', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')));
		const pushed = await agentCommit(t.git, t.base, { 'notes/a.md': 'one\n2\nthree\n' });
		const outcome = expectOk(await t.server.receivePush({ commit: pushed, user: 'claude' }));
		expect(outcome).toMatchObject({ kind: 'refused', path: 'notes/a.md' });
		expect(t.server.overlaySize()).toBe(0);
		const head = await mainCommit(t.git);
		expect(head?.parents).not.toContain(pushed);
		expect(sequenceOf(head?.message ?? '')).toBe(3);
		await t.cleanup();
	});

	test('a renamed file is a move, so an edit made meanwhile follows it', async () => {
		const t = await cloned();
		await t.alice.push(t.batch('alice-laptop', 2, t.write('notes/b.md', 'B\n', 'B\nmore\n')));
		const pushed = await agentCommit(t.git, t.base, { 'notes/b.md': null, 'archive/b.md': 'B\n' });
		expect(expectOk(await t.server.receivePush({ commit: pushed, user: 'claude' })).kind).toBe('applied');
		expect(await t.server.read('archive/b.md')).toBe('B\nmore\n');
		expect(await t.server.read('notes/b.md')).toBeNull();
		await t.cleanup();
	});

	test('unparseable frontmatter, oversized notes and binaries outside LFS are refused', async () => {
		const t = await cloned();
		const cases: [Record<string, string | Uint8Array>, string][] = [
			[{ 'notes/bad.md': '---\na: [\n---\n' }, 'notes/bad.md'],
			[{ 'notes/big.md': 'x'.repeat(1024 * 1024 + 1) }, 'notes/big.md'],
			[{ 'photo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) }, 'photo.png'],
		];
		for (const [files, path] of cases) {
			const pushed = await agentCommit(t.git, t.base, files);
			expect(expectOk(await t.server.receivePush({ commit: pushed, user: 'claude' }))).toMatchObject({ kind: 'refused', path });
		}
		await t.cleanup();
	});

	test('pushing the same commit twice changes nothing the second time', async () => {
		const t = await cloned();
		const pushed = await agentCommit(t.git, t.base, { 'notes/c.md': 'C\n' });
		expectOk(await t.server.receivePush({ commit: pushed, user: 'claude' }));
		expect(expectOk(await t.server.receivePush({ commit: pushed, user: 'claude' }))).toEqual({ kind: 'unchanged' });
		await t.cleanup();
	});
});
