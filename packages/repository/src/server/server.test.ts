/**
 * Repository Server Tests
 *
 * The server is where ordering, merging and durability meet, so these tests
 * drive it directly with batches, a real `bun:sqlite` overlay and a real bare
 * Git repository. Device-level behavior is covered end to end in
 * `e2e.test.ts`; these pin the server's own contract.
 *
 * Key behaviors:
 * - A batch names its policy: `'mark'` overlaps become marker blocks in server order; `'refuse'` refuses the batch
 * - A retried batch returns its recorded outcome, or `applied` once its commit cleared it; a gap is refused
 * - An unknown base answers need-base, and the resent base applies
 * - A change made any number of commits ago is traced exactly, with no window
 * - Edits follow moves; a path is a note's field, so a rename of a renamed note or onto a taken path keeps the current path for people and refuses an agent
 * - A change whose path no longer holds its note goes to a sibling note, and
 *   later changes from the same position follow it
 * - Commits carry `Epicenter-Seq`, a trailer per path event and an
 *   `Epicenter-Overlap` per settled overlap,
 *   clear the overlay and land on a timer
 * - Agent pushes: overlap, breaking a note that parses, and bad files refused, a clean push is a merge parent
 *   whose merge commit records the path events it imported
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
import { pathEventsOf } from './history.js';
import { createRepositoryServer, type ServerOptions, siblingPath } from './server.js';

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
	const alice = server.connect({ device: 'alice-laptop', user: 'alice' });
	const bob = server.connect({ device: 'bob-phone', user: 'bob', onBroadcast: (b) => heard.push(b) });
	const agent = server.connect({ device: 'agent-1', user: 'claude' });
	const numbers = new Map<string, number>();
	/** A device's next batch; the agent waits for its verdicts, so its batches refuse on overlap. */
	const batch = (device: string, seq: number, ...changes: Change[]): Batch => {
		const n = (numbers.get(device) ?? 0) + 1;
		numbers.set(device, n);
		return { device, n, seq, policy: device === 'agent-1' ? 'refuse' : 'mark', changes };
	};
	const write = (path: string, base: string | null, text: string | null): Change => ({
		kind: 'write',
		path,
		base: base === null ? null : { hash: gitBlobHash(base), text: base },
		text,
	});
	const append = (path: string, base: string, text: string): Change => ({
		kind: 'append',
		path,
		text,
		base: { hash: gitBlobHash(base), text: base },
	});
	const move = (from: string, to: string): Change => ({ kind: 'move', from, to });
	return {
		server,
		git,
		alice,
		bob,
		agent,
		heard,
		batch,
		write,
		append,
		move,
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

	test('one device can send a marked batch and a refused one: the policy is the batch\'s', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', 'cat\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', 'cat\n', 'cart\n')));
		const refused = await t.bob.push({ ...t.batch('bob-phone', seq, t.write('notes/a.md', 'cat\n', 'coat\n')), policy: 'refuse' });
		expect(refused).toMatchObject({ kind: 'refused', path: 'notes/a.md' });
		const marked = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'cat\n', 'coat\n')));
		expect(marked).toMatchObject({ kind: 'applied', changes: [{ overlaps: [{ unit: 'body', settled: 'marked' }] }] });
		await t.cleanup();
	});

	test("a 'refuse' batch's overlap is refused and changes nothing", async () => {
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

	test("a note that does not parse takes any text; a write that would break one that parses keeps current for 'mark' and refuses 'refuse'", async () => {
		const t = await setup();
		const broken = '---\ntitle: [\n---\nBody\n';
		const fixed = '---\ntitle: Fixed\n---\nBody\n';
		const seq = await seed(t, 'notes/a.md', broken);
		expect(await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', broken, '---\ntitle: [F\n---\nBody\n')))).toMatchObject({ kind: 'applied' });
		expect(await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', '---\ntitle: [F\n---\nBody\n', fixed)))).toMatchObject({ kind: 'applied' });
		// Alice was repairing it too, from the broken text: merged with Bob's repair, the frontmatter would break again.
		const marked = await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', broken, '---\ntitle: [A\n---\nBody\n')));
		expect(marked).toMatchObject({
			kind: 'applied',
			changes: [{ at: 'notes/a.md', text: fixed, overlaps: [{ unit: 'file', clash: 'unparseable', settled: 'current-kept' }] }],
		});
		const refused = await t.agent.push(t.batch('agent-1', seq, t.write('notes/a.md', fixed, '---\ntitle: [\n---\nBody\n')));
		expect(refused).toMatchObject({ kind: 'refused', path: 'notes/a.md', reason: "the note's frontmatter would no longer parse" });
		expect(await t.server.read('notes/a.md')).toBe(fixed);
		// An append can close a fence and turn an open one into frontmatter that does not parse.
		const open = '---\na: 1\n';
		await seed(t, 'notes/b.md', open);
		const appended = await t.bob.push(t.batch('bob-phone', t.server.sequence(), t.append('notes/b.md', open, 'b: [\n---\n')));
		expect(appended).toMatchObject({ kind: 'applied', changes: [{ text: open, overlaps: [{ unit: 'file', clash: 'unparseable' }] }] });
		await t.cleanup();
	});

	test("two creates at one path are joined for 'mark' and refused for 'refuse'", async () => {
		const t = await setup();
		await t.alice.push(t.batch('alice-laptop', 0, t.write('notes/a.md', null, '---\nstatus: a\n---\nbody c\n')));
		const refused = await t.agent.push(t.batch('agent-1', 0, t.write('notes/a.md', null, '---\nstatus: b\n---\nbody i\n')));
		expect(refused).toMatchObject({ kind: 'refused', path: 'notes/a.md', reason: 'both sides created the file' });
		const joined = await t.bob.push(t.batch('bob-phone', 0, t.write('notes/a.md', null, '---\nstatus: b\n---\nbody i\n')));
		expect(joined).toMatchObject({
			kind: 'applied',
			changes: [{ overlaps: [{ unit: 'file', clash: 'created', settled: 'joined' }, { unit: 'field', key: 'status', settled: 'current-kept' }] }],
		});
		expect(await t.server.read('notes/a.md')).toBe('---\nstatus: a\n---\nbody c\n\nbody i\n');
		await t.cleanup();
	});

	test('a retried batch returns its recorded outcome without applying twice', async () => {
		const t = await setup();
		const batch = t.batch('alice-laptop', 0, { kind: 'write', path: 'log.md', base: null, text: 'one\n' });
		const first = await t.alice.push(batch);
		const again = await t.alice.push({ ...batch, changes: [t.append('log.md', 'one\n', 'two\n')] });
		expect(again).toEqual(first);
		expect(await t.server.read('log.md')).toBe('one\n');
		expect(await t.alice.push({ device: 'alice-laptop', n: 5, seq: 1, policy: 'mark', changes: [] })).toMatchObject({ kind: 'refused' });
		await t.cleanup();
	});

	test('a retry whose receipt left with its commit is applied with no detail; a refusal keeps its receipt', async () => {
		const t = await setup();
		const landed = t.batch('alice-laptop', 0, t.write('a.md', null, 'A\n'));
		expect((await t.alice.push(landed)).kind).toBe('applied');
		const refused = t.batch('agent-1', 0, t.write('a.md', null, 'agent\n'));
		expect((await t.agent.push(refused)).kind).toBe('refused');
		t.advance(8 * 24 * 3600e3);
		expectOk(await t.server.tick());
		expect(await t.alice.push(landed)).toEqual({ kind: 'applied', seq: null, changes: [] });
		expect(await t.agent.push(refused)).toMatchObject({ kind: 'refused', reason: 'both sides created the file' });
		expect(await t.server.read('a.md')).toBe('A\n');
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

	test('an edit made any number of commits ago merges into the file, with no window', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', 'a\nb\n');
		for (let k = 0; k < 10; k++) {
			await seed(t, `notes/x${k}.md`, 'x\n');
			t.advance(30 * 24 * 3600e3);
			expectOk(await t.server.tick());
		}
		await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('notes/a.md', 'a\nb\n', 'A\nb\n')));
		expectOk(await t.server.commit());
		const agent = await t.agent.push(t.batch('agent-1', seq, t.write('notes/a.md', 'a\nb\n', 'a\nB\n')));
		expect(agent).toMatchObject({ kind: 'applied', changes: [{ at: 'notes/a.md', overlaps: [] }] });
		expect(await t.server.read('notes/a.md')).toBe('A\nB\n');
		await t.cleanup();
	});

	test('an edit follows a move; a move onto a taken path keeps the occupant for people and is refused for agents', async () => {
		const t = await setup();
		await seed(t, 'notes/a.md', 'A\n');
		const seq = await seed(t, 'notes/b.md', 'B\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.move('notes/a.md', 'notes/renamed.md')));
		const edit = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'A\n', 'A edited\n')));
		expect(edit).toMatchObject({ kind: 'applied', changes: [{ path: 'notes/a.md', at: 'notes/renamed.md', movedTo: 'notes/renamed.md' }] });
		expect(await t.server.read('notes/renamed.md')).toBe('A edited\n');
		expect(await t.server.read('notes/a.md')).toBeNull();
		const now = t.server.sequence();
		const refused = await t.agent.push(t.batch('agent-1', now, t.move('notes/b.md', 'notes/renamed.md')));
		expect(refused).toEqual({
			kind: 'refused',
			path: 'notes/renamed.md',
			reason: 'the destination is taken',
			overlaps: [{ unit: 'path', clash: 'taken', relocatedTo: null }],
		});
		expect(t.server.sequence()).toBe(now);
		// A person's move is never refused: the occupant keeps the path, and the note stays.
		const kept = await t.alice.push(t.batch('alice-laptop', now, t.move('notes/b.md', 'notes/renamed.md')));
		expect(kept).toMatchObject({
			kind: 'applied',
			changes: [{ path: 'notes/b.md', at: 'notes/b.md', text: 'B\n', overlaps: [{ unit: 'path', clash: 'taken', settled: 'current-kept' }] }],
		});
		expect(await t.server.read('notes/renamed.md')).toBe('A edited\n');
		expect(await t.server.read('notes/b.md')).toBe('B\n');
		// A move a device made before it saw the same move land is already done.
		const same = await t.bob.push(t.batch('bob-phone', seq, t.move('notes/a.md', 'notes/renamed.md')));
		expect(same).toMatchObject({ kind: 'applied', changes: [{ path: 'notes/a.md', at: 'notes/renamed.md', movedTo: 'notes/renamed.md' }] });
		await t.cleanup();
	});

	test('two renames of one note: the current path wins for people, and an agent is refused', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/trip.md', 'Trip\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.move('notes/trip.md', 'notes/kyoto.md')));
		const kept = await t.bob.push(t.batch('bob-phone', seq, t.move('notes/trip.md', 'notes/japan.md')));
		expect(kept).toMatchObject({
			kind: 'applied',
			changes: [
				{
					path: 'notes/trip.md',
					at: 'notes/kyoto.md',
					movedTo: 'notes/kyoto.md',
					overlaps: [{ unit: 'field', key: 'path', current: 'notes/kyoto.md', incoming: 'notes/japan.md', settled: 'current-kept' }],
				},
			],
		});
		const refused = await t.agent.push(t.batch('agent-1', seq, t.move('notes/trip.md', 'notes/japan.md')));
		expect(refused).toMatchObject({ kind: 'refused', path: 'notes/trip.md', reason: 'the note was renamed elsewhere' });
		expect(await t.server.read('notes/kyoto.md')).toBe('Trip\n');
		expect(await t.server.read('notes/japan.md')).toBeNull();
		// No sibling is made for a move.
		await t.server.commit();
		expect([...(await t.git.readTree((await t.git.readCommit((await t.git.readRef('refs/heads/main')) ?? ''))?.tree ?? '')).keys()]).toEqual(['notes/kyoto.md']);
		await t.cleanup();
	});

	test('an edit to a deleted path that was reused becomes a sibling, and later edits follow it', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', 'old\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', 'old\n', null)));
		await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('notes/a.md', null, 'different note\n')));
		const sibling = 'notes/a (bob, 2026-10-28).md';
		const edit = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'old\n', 'old edited\n')));
		expect(edit).toMatchObject({
			kind: 'applied',
			changes: [{ at: sibling, text: 'old edited\n', overlaps: [{ unit: 'path', clash: 'reused', relocatedTo: sibling, settled: 'relocated' }] }],
		});
		// Bob's next batch, still from the old position, lands on the same sibling.
		const next = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'old edited\n', 'old edited twice\n')));
		expect(next).toMatchObject({ kind: 'applied', changes: [{ at: sibling, movedTo: sibling, overlaps: [] }] });
		// Another device's stale edit of the same note converges on that sibling.
		const carol = t.server.connect({ device: 'carol-tablet', user: 'carol' });
		await carol.push({ device: 'carol-tablet', n: 1, seq, policy: 'mark', changes: [t.write('notes/a.md', 'old\n', 'old\ncarol\n')] });
		expect(await t.server.read('notes/a.md')).toBe('different note\n');
		expect(await t.server.read(sibling)).toBe('old edited twice\ncarol\n');
		expectOk(await t.server.commit());
		expect((await mainCommit(t.git))?.message).toContain(
			'Epicenter-Overlap: "notes/a.md" path reused relocated -> "notes/a (bob, 2026-10-28).md"; seq 4 by bob\n',
		);
		await t.cleanup();
	});

	describe('a delete and a re-create at one path are a reuse, traced through Git', () => {
		for (const interval of ['separate commits', 'one commit interval'] as const)
			test(`in ${interval}, the old edit becomes a sibling note, and later edits follow it there`, async () => {
				const driver = openBunSqlite();
				const t = await setup({ driver });
				const seq = await seed(t, 'notes/a.md', 'old\n');
				expectOk(await t.server.commit());
				await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', 'old\n', null)));
				if (interval === 'separate commits') expectOk(await t.server.commit());
				await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('notes/a.md', null, 'different note\n')));
				expectOk(await t.server.commit());
				expect(driver.all('SELECT * FROM history')).toEqual([]);
				const sibling = 'notes/a (bob, 2026-10-28).md';
				const edit = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'old\n', 'old edited\n')));
				expect(edit).toMatchObject({
					kind: 'applied',
					changes: [{ at: sibling, text: 'old edited\n', overlaps: [{ unit: 'path', clash: 'reused', relocatedTo: sibling, settled: 'relocated' }] }],
				});
				expect(await t.server.read('notes/a.md')).toBe('different note\n');
				// Once the sibling is committed, its Epicenter-Relocate trailer sends later stale edits there.
				expectOk(await t.server.commit());
				const next = await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', 'old edited\n', 'old edited twice\n')));
				expect(next).toMatchObject({ kind: 'applied', changes: [{ at: sibling, movedTo: sibling, overlaps: [] }] });
				expect(await t.server.read(sibling)).toBe('old edited twice\n');
				// An edit made after the re-create is the new note's.
				const fresh = await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('notes/a.md', 'different note\n', 'different note!\n')));
				expect(fresh).toMatchObject({ kind: 'applied', changes: [{ at: 'notes/a.md', movedTo: null }] });
				await t.cleanup();
			});
	});

	test('a later change in the same batch follows that batch\'s relocation', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/c.md', 'old\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/c.md', 'old\n', null)));
		await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('notes/c.md', null, 'different note\n')));
		await t.bob.push(t.batch('bob-phone', seq, t.write('notes/c.md', 'old\n', 'bob\n'), t.append('notes/c.md', 'bob\n', 'more\n')));
		expect(await t.server.read('notes/c (bob, 2026-10-28).md')).toBe('bob\nmore\n');
		expect(await t.server.read('notes/c (bob, 2026-10-28, 2).md')).toBeNull();
		await t.cleanup();
	});

	test('an append to a reused path keeps its base and the append in a sibling', async () => {
		const t = await setup();
		const seq = await seed(t, 'log.md', 'old log\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('log.md', 'old log\n', null)));
		await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('log.md', null, 'new log\n')));
		const outcome = await t.bob.push(t.batch('bob-phone', seq, t.append('log.md', 'old log\n', 'bob\n')));
		expect(outcome).toMatchObject({ kind: 'applied', changes: [{ at: 'log (bob, 2026-10-28).md' }] });
		expect(await t.server.read('log (bob, 2026-10-28).md')).toBe('old log\nbob\n');
		expect(await t.server.read('log.md')).toBe('new log\n');
		await t.cleanup();
	});

	test('an append to a deleted note brings it back as its base and the append', async () => {
		const t = await setup();
		const seq = await seed(t, 'log.md', 'log\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('log.md', 'log\n', null)));
		const outcome = await t.bob.push(t.batch('bob-phone', seq, t.append('log.md', 'log\n', 'bob\n')));
		expect(outcome).toMatchObject({
			kind: 'applied',
			changes: [{ at: 'log.md', text: 'log\nbob\n', overlaps: [{ unit: 'file', clash: 'deleted', side: 'current', settled: 'edit-kept' }] }],
		});
		expect(await t.server.read('log.md')).toBe('log\nbob\n');
		await t.cleanup();
	});

	test('an edit that brought a deleted note back is the same note to later edits (bug A)', async () => {
		// Probe A: Alice deletes; Bob's unseen edit resurrects; Carol's unseen
		// edit used to be treated as aimed at a different note.
		const t = await setup();
		const seq = await seed(t, 'n.md', 'v1\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('n.md', 'v1\n', null)));
		await t.bob.push(t.batch('bob-phone', seq, t.write('n.md', 'v1\n', 'v1 bob\n')));
		const carol = t.server.connect({ device: 'carol-tablet', user: 'carol' });
		const outcome = await carol.push({ device: 'carol-tablet', n: 1, seq, policy: 'mark', changes: [t.write('n.md', 'v1\n', 'carol v1\n')] });
		expect(outcome).toMatchObject({ kind: 'applied', changes: [{ at: 'n.md', overlaps: [] }] });
		expect(await t.server.read('n.md')).toBe('carol v1 bob\n');
		expect(await t.server.read('n (carol, 2026-10-28).md')).toBeNull();
		await t.cleanup();
	});

	test('an append aimed at a note deleted and re-created across commits goes to a sibling', async () => {
		const t = await setup();
		const seq = await seed(t, 'n.md', 'old note\n');
		expectOk(await t.server.commit());
		await t.alice.push(t.batch('alice-laptop', seq, t.write('n.md', 'old note\n', null)));
		expectOk(await t.server.commit());
		await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('n.md', null, 'different note\n')));
		expectOk(await t.server.commit());
		const refused = await t.agent.push(t.batch('agent-1', seq, t.append('n.md', 'old note\n', 'agent reply\n')));
		expect(refused).toMatchObject({ kind: 'refused', path: 'n.md', reason: 'the file was deleted and its path reused' });
		// The base is the old note's text, which Git still holds by hash.
		const outcome = await t.bob.push(
			t.batch('bob-phone', seq, { kind: 'append', path: 'n.md', text: 'bob reply\n', base: { hash: gitBlobHash('old note\n') } }),
		);
		expect(outcome).toMatchObject({ kind: 'applied', changes: [{ at: 'n (bob, 2026-10-28).md' }] });
		expect(await t.server.read('n.md')).toBe('different note\n');
		expect(await t.server.read('n (bob, 2026-10-28).md')).toBe('old note\nbob reply\n');
		await t.cleanup();
	});

	test('a move of a note deleted and re-created across commits is dropped, and moves nothing', async () => {
		const t = await setup();
		const seq = await seed(t, 'n.md', 'old note\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('n.md', 'old note\n', null)));
		expectOk(await t.server.commit());
		await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('n.md', null, 'different note\n')));
		expectOk(await t.server.commit());
		const outcome = await t.bob.push(t.batch('bob-phone', seq, t.move('n.md', 'm.md')));
		expect(outcome).toMatchObject({ kind: 'applied', changes: [{ path: 'n.md', at: null, overlaps: [{ unit: 'path', clash: 'gone', settled: 'dropped' }] }] });
		expect(await t.server.read('n.md')).toBe('different note\n');
		expect(await t.server.read('m.md')).toBeNull();
		await t.cleanup();
	});

	test('after many commits, an append or move of an unchanged file applies', async () => {
		const t = await setup();
		const seq = await seed(t, 'a.md', 'a\n');
		await seed(t, 'b.md', 'b\n');
		t.advance(8 * 24 * 3600e3);
		expectOk(await t.server.tick());
		await seed(t, 'x.md', 'x\n');
		expectOk(await t.server.commit());
		await t.bob.push(t.batch('bob-phone', seq, t.append('a.md', 'a\n', 'more\n'), t.move('b.md', 'c.md')));
		expect(await t.server.read('a.md')).toBe('a\nmore\n');
		expect(await t.server.read('c.md')).toBe('b\n');
		await t.cleanup();
	});

	test('a move whose note was deleted is dropped', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', 'A\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', 'A\n', null)));
		const outcome = await t.bob.push(t.batch('bob-phone', seq, t.move('notes/a.md', 'notes/b.md')));
		expect(outcome).toMatchObject({ kind: 'applied', changes: [{ at: null, overlaps: [{ unit: 'path', clash: 'gone', settled: 'dropped' }] }] });
		expect(await t.server.read('notes/b.md')).toBeNull();
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

describe('siblingPath', () => {
	const at = Date.parse('2026-10-28T23:59:00Z');
	test('names the user and the day, and counts past taken names', () => {
		const taken = new Set(['tasks/fix-login (bob, 2026-10-28).md', 'tasks/fix-login (bob, 2026-10-28, 2).md']);
		expect(siblingPath('tasks/fix-login.md', 'bob', at, () => false)).toBe('tasks/fix-login (bob, 2026-10-28).md');
		expect(siblingPath('tasks/fix-login.md', 'bob', at, (p) => taken.has(p))).toBe('tasks/fix-login (bob, 2026-10-28, 3).md');
		expect(siblingPath('settings.md', 'bob', at, () => false)).toBe('settings (bob, 2026-10-28).md');
	});

	test('a user id never adds a folder or a hidden name', () => {
		expect(siblingPath('a/b.md', '.x/y\\z', at, () => false)).toBe('a/b (-x-y-z, 2026-10-28).md');
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

	test('every settled overlap is named in the commit by an Epicenter-Overlap trailer', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a.md', '---\nstatus: todo\n---\ncat\n');
		await t.alice.push(t.batch('alice-laptop', seq, t.write('notes/a.md', '---\nstatus: todo\n---\ncat\n', '---\nstatus: done\n---\ncart\n')));
		await t.bob.push(t.batch('bob-phone', seq, t.write('notes/a.md', '---\nstatus: todo\n---\ncat\n', '---\nstatus: wontfix\n---\ncoat\n')));
		await seed(t, 'notes/b.md', 'clean\n');
		expectOk(await t.server.commit());
		const head = await mainCommit(t.git);
		expect(head?.message).toBe(
			[
				'Update 2 files',
				'',
				'Epicenter-Seq: 4',
				'Epicenter-Create: "notes/a.md"; seq 1',
				'Epicenter-Create: "notes/b.md"; seq 4',
				'Epicenter-Overlap: "notes/a.md" field "status" current-kept; seq 3 by bob',
				'Epicenter-Overlap: "notes/a.md" body marked; seq 3 by bob',
				'Co-authored-by: alice <alice@users.epicenter.invalid>',
				'Co-authored-by: bob <bob@users.epicenter.invalid>',
				'',
			].join('\n'),
		);
		await t.cleanup();
	});

	test('every path event is recorded exactly in a trailer, and reads back from the message', async () => {
		const t = await setup();
		const seq = await seed(t, 'notes/a "quoted".md', 'A\n');
		await seed(t, 'notes/b.md', 'B\n');
		await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.move('notes/a "quoted".md', 'archive/a.md')));
		await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('notes/b.md', 'B\n', null)));
		await t.alice.push(t.batch('alice-laptop', t.server.sequence(), t.write('notes/b.md', null, 'another B\n')));
		await t.bob.push(t.batch('bob-phone', seq, t.write('notes/b.md', 'B\n', 'B by bob\n')));
		expectOk(await t.server.commit());
		const message = (await mainCommit(t.git))?.message ?? '';
		const sibling = 'notes/b (bob, 2026-10-28).md';
		const trailers = [
			'Epicenter-Create: "notes/a \\"quoted\\".md"; seq 1',
			'Epicenter-Create: "notes/b.md"; seq 2',
			'Epicenter-Move: "notes/a \\"quoted\\".md" -> "archive/a.md"; seq 3',
			'Epicenter-Delete: "notes/b.md"; seq 4',
			'Epicenter-Create: "notes/b.md"; seq 5',
			`Epicenter-Create: "${sibling}"; seq 6`,
			`Epicenter-Relocate: "notes/b.md" -> "${sibling}"; before 4; seq 6`,
		];
		expect(message).toContain(`Epicenter-Seq: 6\n${trailers.map((line) => `${line}\n`).join('')}Epicenter-Overlap:`);
		expect(pathEventsOf(message)).toEqual([
			{ kind: 'create', path: 'notes/a "quoted".md', seq: 1 },
			{ kind: 'create', path: 'notes/b.md', seq: 2 },
			{ kind: 'move', path: 'notes/a "quoted".md', dest: 'archive/a.md', seq: 3 },
			{ kind: 'delete', path: 'notes/b.md', seq: 4 },
			{ kind: 'create', path: 'notes/b.md', seq: 5 },
			{ kind: 'create', path: sibling, seq: 6 },
			{ kind: 'relocate', path: 'notes/b.md', dest: sibling, before: 4, seq: 6 },
		]);
		await t.cleanup();
	});

	test('the Git store lists the first-parent commits after a sequence, oldest first', async () => {
		const t = await setup();
		const oids: string[] = [];
		for (const name of ['a', 'b', 'c']) {
			await seed(t, `${name}.md`, `${name}\n`);
			oids.push(expectOk(await t.server.commit())?.oid ?? '');
		}
		const head = oids.at(-1) ?? '';
		expect((await t.git.commitsAfter(head, 1)).map((commit) => commit.oid)).toEqual(oids.slice(1));
		expect((await t.git.commitsAfter(head, 0)).map((commit) => sequenceOf(commit.message))).toEqual([1, 2, 3]);
		expect(await t.git.commitsAfter(head, 3)).toEqual([]);
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

	test('the merge commit records the moves it imported, so an older edit follows them later', async () => {
		const t = await cloned();
		const pushed = await agentCommit(t.git, t.base, { 'notes/b.md': null, 'archive/b.md': 'B\n' });
		expect(expectOk(await t.server.receivePush({ commit: pushed, user: 'claude' })).kind).toBe('applied');
		const head = await mainCommit(t.git);
		expect(head?.message).toContain('Epicenter-Move: "notes/b.md" -> "archive/b.md"; seq 3\n');
		expect(t.server.overlaySize()).toBe(0);
		const edit = await t.bob.push(t.batch('bob-phone', 2, t.write('notes/b.md', 'B\n', 'B\nby bob\n')));
		expect(edit).toMatchObject({ kind: 'applied', changes: [{ at: 'archive/b.md', movedTo: 'archive/b.md' }] });
		expect(await t.server.read('archive/b.md')).toBe('B\nby bob\n');
		await t.cleanup();
	});

	test('breaking frontmatter that parses, oversized notes and binaries outside LFS are refused', async () => {
		const t = await cloned();
		const cases: [Record<string, string | Uint8Array>, string][] = [
			[{ 'notes/a.md': '---\na: [\n---\none\n' }, 'notes/a.md'],
			[{ 'notes/big.md': 'x'.repeat(1024 * 1024 + 1) }, 'notes/big.md'],
			[{ 'photo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) }, 'photo.png'],
		];
		for (const [files, path] of cases) {
			const pushed = await agentCommit(t.git, t.base, files);
			expect(expectOk(await t.server.receivePush({ commit: pushed, user: 'claude' }))).toMatchObject({ kind: 'refused', path });
		}
		await t.cleanup();
	});

	test('a new note that does not parse lands, and so does each step of its repair', async () => {
		const t = await cloned();
		const broken = await agentCommit(t.git, t.base, { 'notes/bad.md': '---\na: [\n---\n' });
		expect(expectOk(await t.server.receivePush({ commit: broken, user: 'claude' })).kind).toBe('applied');
		const step = await agentCommit(t.git, broken, { 'notes/bad.md': '---\na: [1\n---\n' });
		expect(expectOk(await t.server.receivePush({ commit: step, user: 'claude' })).kind).toBe('applied');
		const fixed = await agentCommit(t.git, step, { 'notes/bad.md': '---\na: [1]\n---\n' });
		expect(expectOk(await t.server.receivePush({ commit: fixed, user: 'claude' })).kind).toBe('applied');
		expect(await t.server.read('notes/bad.md')).toBe('---\na: [1]\n---\n');
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
