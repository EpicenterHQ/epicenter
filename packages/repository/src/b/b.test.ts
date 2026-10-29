/**
 * Design B Scenario Tests
 *
 * The intent of today's engine's held, reconcile, verdict and delete/reuse
 * tests, asserted under design B after phase 0a: live commits with parents,
 * the server merging merge-mode commits, the commit id as idempotency, a
 * commit on every save, no stored notices (conflict blocks in the text, and
 * held work with a reason on the device), and a retention window. Each world
 * has a fixed latency and no loss unless a test loses a reply. The people
 * review's probes live in `b.people.test.ts`.
 *
 * Key behaviors:
 * - A text that would break a parsing note is held, never committed; a repair commits exactly the repaired text
 * - Held text survives a change from elsewhere (rebased) and a restart; held text a merge made parse is published only by its person's save
 * - Held text over a remote delete stays held (a missing file below must parse)
 * - A lost reply is answered by sending the same commit again, which lands once, with its outcome brought up to now; typing since never conflicts with itself
 * - A commit meeting a moved `main` is merged by the server in one push; the device never sends an edit made elsewhere back as its own
 * - Changed (D3): an edit made before a delete, landing after the note was brought back or replaced, is one block in the note there
 * - A rename racing an edit of the old path keeps both, and the renamer's delete stays held
 * - An agent's fast-forward commit is refused when `main` moved and changes nothing; the server refuses commits with no parent, a bad id, or a path named twice
 * - Every save commits while online; saves while a commit is in flight, or offline, amend one unsent commit; a sent commit is never rewritten
 * - A commit sent once whose parent left the window merges again after a full catch-up
 */
import { expect, test } from 'bun:test';
import { parses } from '../markdown.js';
import { createWorld, QUIET } from './harness.js';
import type { Request } from './replica.js';
import { commitId, createServer, type LiveCommit } from './server.js';

const PATH = 'notes/a.md';
const note = (body: string, title = 'A') => `---\ntitle: ${title}\n---\n${body}`;
/** Frontmatter that does not parse: a key given twice. */
const broken = (body: string, title = 'A') => `---\ntitle: ${title}\ntitle: B\n---\n${body}`;

function setup(names = ['alice', 'bob']) {
	const world = createWorld({ latency: { min: 20, max: 20 } });
	const pushes: { device: string; commit: LiveCommit }[] = [];
	world.onRequest((device, request: Request) => {
		if (request.type === 'push') pushes.push({ device, commit: request.commit });
	});
	const devices = names.map((name) => world.device(name));
	world.net.runFor(500);
	const [alice, bob, carol] = devices;
	if (alice === undefined || bob === undefined) throw new Error('two devices');
	/** Every text a device ever pushed for a path. */
	const sent = (device: string, path: string) =>
		pushes.filter((p) => p.device === device).flatMap((p) => p.commit.files.filter((f) => f.path === path).map((f) => f.text));
	/** Run until everything is quiet, short of the quiet-time flush. */
	const settle = () => world.net.runFor(QUIET - 1_000);
	return { world, alice, bob, carol, pushes, sent, settle };
}

// ============================================================================
// Held text (held.test.ts)
// ============================================================================

test('a text that would break a note that parses is held: never committed, never sent', () => {
	const { world, alice, sent, settle } = setup();
	alice.replica.write(PATH, note('one\n'));
	settle();
	alice.replica.write(PATH, broken('one\n'));
	settle();
	expect(alice.replica.read(PATH)).toBe(broken('one\n'));
	expect(alice.replica.held()).toEqual([{ path: PATH, reason: 'does not parse' }]);
	expect(world.server.read(PATH)).toBe(note('one\n'));
	expect(sent('alice', PATH).every((text) => text === null || parses(text))).toBe(true);
});

test('held text survives a change from elsewhere and a restart, and a repair commits exactly the repaired text', () => {
	const { world, alice, bob, pushes, settle } = setup();
	alice.replica.write(PATH, note('one\n.\n.\nbob\n'));
	settle();
	alice.replica.write(PATH, broken('ONE\n.\n.\nbob\n'));
	bob.replica.edit(PATH, () => note('one\n.\n.\nBOB\n'));
	settle();
	expect(alice.replica.read(PATH)).toBe(broken('ONE\n.\n.\nBOB\n'));
	alice.restart();
	settle();
	expect(alice.replica.read(PATH)).toBe(broken('ONE\n.\n.\nBOB\n'));
	expect(alice.replica.state(PATH)).toEqual({ status: 'held', reason: 'does not parse' });
	const before = pushes.length;
	alice.replica.edit(PATH, () => note('ONE\n.\n.\nBOB\n', 'B'));
	settle();
	expect(pushes.slice(before).map((p) => p.commit.files)).toEqual([[{ path: PATH, text: note('ONE\n.\n.\nBOB\n', 'B') }]]);
	expect(world.server.read(PATH)).toBe(note('ONE\n.\n.\nBOB\n', 'B'));
});

test('held text over a remote delete stays held, because a missing file below counts as one that must parse', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n'));
	settle();
	alice.setOnline(false);
	alice.replica.write(PATH, broken('one\n'));
	bob.replica.write(PATH, null);
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBeNull();
	expect(alice.replica.held()).toEqual([{ path: PATH, reason: 'does not parse' }]);
	alice.replica.edit(PATH, () => note('one\nkept\n'));
	settle();
	expect(world.server.read(PATH)).toBe(note('one\nkept\n'));
});

test('changed: held text that a merge made parse is published only by its person\'s save', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n'));
	settle();
	alice.replica.write(PATH, broken('one\n'));
	// Bob removes the title Alice gave twice, which leaves hers once.
	bob.replica.edit(PATH, () => '---\n---\none\n');
	settle();
	expect(alice.replica.read(PATH)).toBe('---\ntitle: B\n---\none\n');
	expect(alice.replica.state(PATH)).toEqual({ status: 'held', reason: 'merged while held: save it to send' });
	// Saving another note does not publish it.
	alice.replica.write('notes/other.md', note('other\n'));
	settle();
	expect(world.server.read(PATH)).toBe('---\n---\none\n');
	alice.replica.edit(PATH, (text) => text);
	settle();
	expect(world.server.read(PATH)).toBe('---\ntitle: B\n---\none\n');
});

// ============================================================================
// Lost replies (verdict.test.ts) and meeting a moved main (reconcile.test.ts)
// ============================================================================

test('a lost reply is answered by sending the same commit again, which lands once', () => {
	const { world, alice, pushes, settle } = setup();
	alice.replica.write(PATH, note('one\n'));
	settle();
	const commits = world.server.history().commits;
	alice.loseNextReply();
	alice.replica.write(PATH, note('two\n'));
	settle();
	expect(world.server.read(PATH)).toBe(note('two\n'));
	const ids = pushes.map((p) => p.commit.id);
	expect(ids.at(-1)).toBe(ids.at(-2));
	expect(world.server.history().commits).toBe(commits + 1);
	expect(alice.replica.state(PATH)).toEqual({ status: 'synced' });
});

test('a resend gets its outcome brought up to now: the device stands on today\'s main, not the one it landed on', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n.\n.\nend\n'));
	settle();
	alice.loseNextReply();
	alice.replica.edit(PATH, () => note('ONE\n.\n.\nend\n'));
	world.net.runFor(100);
	bob.replica.edit(PATH, (text) => (text ?? '').replace('end', 'END'));
	settle();
	expect(world.server.read(PATH)).toBe(note('ONE\n.\n.\nEND\n'));
	expect(alice.replica.read(PATH)).toBe(world.server.read(PATH));
	expect(alice.replica.position()).toBe(world.server.main());
});

test('a lost reply, more typing on the same line, and an edit elsewhere merge with no conflict with itself', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n.\n.\nbob\n'));
	settle();
	alice.loseNextReply();
	alice.replica.edit(PATH, () => note('one two\n.\n.\nbob\n'));
	world.net.runFor(100);
	alice.replica.edit(PATH, () => note('one two three\n.\n.\nbob\n'));
	bob.replica.edit(PATH, (text) => (text ?? '').replace('bob\n', 'BOB\n'));
	settle();
	expect(world.server.read(PATH)).toBe(note('one two three\n.\n.\nBOB\n'));
	expect(alice.replica.read(PATH)).toBe(note('one two three\n.\n.\nBOB\n'));
});

test('a commit meeting a moved main is merged by the server in one push, and sends no edit made elsewhere back as its own', () => {
	const { world, alice, bob, pushes, settle } = setup();
	alice.replica.write(PATH, note('one\n.\n.\nb0\n'));
	settle();
	bob.replica.edit(PATH, () => note('one\n.\n.\nb1\n'));
	world.net.runFor(5);
	alice.replica.edit(PATH, () => note('one\n.\n.\nb0\n', 'T1'));
	settle();
	expect(world.server.read(PATH)).toBe(note('one\n.\n.\nb1\n', 'T1'));
	const mine = pushes.filter((p) => p.device === 'alice').at(-1)?.commit;
	expect(pushes.filter((p) => p.commit.id === mine?.id)).toHaveLength(1);
	expect(mine?.files).toEqual([{ path: PATH, text: note('one\n.\n.\nb0\n', 'T1') }]);
});

test('typing while a commit is in flight makes a new commit on top of the answer; the sent one is never rewritten', () => {
	const { alice, pushes, settle } = setup();
	alice.replica.write(PATH, note('one\n'));
	alice.replica.write(PATH, note('one\ntwo\n'));
	settle();
	const [first, second] = pushes.map((p) => p.commit);
	expect(first?.files[0]?.text).toBe(note('one\n'));
	expect(second?.parent).toBe(first?.id);
	expect(second?.files[0]?.text).toBe(note('one\ntwo\n'));
});

// ============================================================================
// Deletes and reused paths (e2e.test.ts)
// ============================================================================

test('changed: a later unseen edit of a note deleted and brought back by an edit lands as one block in it (bug A, D3)', () => {
	const { world, alice, bob, carol, settle } = setup(['alice', 'bob', 'carol']);
	alice.replica.write('notes/n.md', 'v1\n');
	settle();
	bob.setOnline(false);
	carol?.setOnline(false);
	bob.replica.edit('notes/n.md', () => 'v1 bob\n');
	carol?.replica.edit('notes/n.md', () => 'carol v1\n');
	alice.replica.write('notes/n.md', null);
	settle();
	bob.setOnline(true);
	settle();
	carol?.setOnline(true);
	settle();
	const text = world.server.read('notes/n.md') ?? '';
	expect(text.startsWith('v1 bob\n<<<<<<< ')).toBe(true);
	expect(text).toContain('carol v1');
});

test('a rename racing an edit of the old path keeps both, and the renamer\'s delete stays held until saved again', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n'));
	settle();
	alice.setOnline(false);
	alice.replica.writeAll({ [PATH]: null, 'notes/b.md': note('one\n') });
	bob.replica.edit(PATH, () => note('one\nbob\n'));
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.snapshot()).toEqual(
		new Map([
			[PATH, note('one\nbob\n')],
			['notes/b.md', note('one\n')],
		]),
	);
	expect(alice.replica.state(PATH)).toEqual({ status: 'held', reason: 'edited after you deleted it' });
});

// ============================================================================
// Agents, the server's refusals, cadence, the window
// ============================================================================

test("an agent's fast-forward commit is refused when main moved and changes nothing; on main it applies, and merge mode is merged", () => {
	const world = createWorld({ latency: { min: 20, max: 20 } });
	const alice = world.device('alice');
	const agent = world.device('agent', { mode: 'fast-forward' });
	world.net.runFor(500);
	alice.replica.write(PATH, note('one\n'));
	world.net.runFor(500);
	alice.replica.edit(PATH, () => note('one\nalice\n'));
	world.net.runFor(5);
	agent.replica.edit(PATH, () => note('one\nagent\n'));
	world.net.runFor(2_000);
	expect(world.server.read(PATH)).toBe(note('one\nalice\n'));
	expect(agent.replica.lastRefusal()).toBe('main moved');
	expect(agent.replica.read(PATH)).toBe(note('one\nalice\n'));
	agent.replica.edit(PATH, () => note('one\nalice\nagent\n'));
	world.net.runFor(2_000);
	expect(world.server.read(PATH)).toBe(note('one\nalice\nagent\n'));
	alice.replica.edit(PATH, () => note('zero\none\nalice\nagent\n'));
	world.net.runFor(5);
	agent.replica.edit(PATH, () => note('one\nalice\nagent\nagain\n'), { commitMode: 'merge' });
	world.net.runFor(2_000);
	expect(world.server.read(PATH)).toBe(note('zero\none\nalice\nagent\nagain\n'));
});

test('the server refuses a commit with no parent, a bad id, or a path named twice, and a resend gets the recorded outcome', () => {
	const server = createServer({ members: ['x'] });
	const session = { member: 'x' };
	const make = (files: LiveCommit['files'], mode: LiveCommit['mode'] = 'merge'): LiveCommit => {
		const body = { parent: server.main(), mode, author: { user: 'x', device: 'x' }, time: 't', files };
		return { id: commitId(body), ...body };
	};
	const first = make([{ path: PATH, text: note('one\n') }]);
	expect(server.push(first, session)).toMatchObject({ kind: 'applied', main: first.id });
	expect(server.push(first, session)).toMatchObject({ kind: 'applied', main: first.id });
	expect(server.history().commits).toBe(1);
	expect(server.push({ ...make([]), parent: undefined } as unknown as LiveCommit, session)).toMatchObject({ kind: 'refused', reason: 'no parent' });
	expect(server.push({ ...make([{ path: PATH, text: 'x' }]), id: 'forged' }, session)).toMatchObject({ kind: 'refused', reason: 'the id is not the hash of the commit' });
	expect(server.push(make([{ path: 'notes/b.md', text: '---\n---\nb\n' }, { path: 'notes/B.md', text: '---\n---\nc\n' }]), session)).toMatchObject({
		kind: 'refused',
		reason: 'a path is named twice',
	});
	expect(server.push(make([{ path: PATH, text: broken('one\n') }], 'fast-forward'), session)).toMatchObject({ kind: 'refused', reason: 'does not parse' });
	expect(server.snapshot()).toEqual(new Map([[PATH, note('one\n')]]));
});

test('every save commits while online; saves while a commit is in flight, or offline, amend one unsent commit', () => {
	const { world, alice, pushes, settle } = setup();
	for (let i = 1; i <= 10; i++) {
		alice.replica.write(PATH, note(`${'x'.repeat(i)}\n`));
		world.net.runFor(100);
	}
	// A round trip is 40 ms: each save went alone.
	expect(new Set(pushes.map((p) => p.commit.id)).size).toBe(10);
	// Three saves inside one round trip: the first goes, the next two amend one commit.
	alice.replica.write(PATH, note('a\n'));
	alice.replica.write(PATH, note('ab\n'));
	alice.replica.write(PATH, note('abc\n'));
	settle();
	expect(pushes.slice(10).map((p) => p.commit.files[0]?.text)).toEqual([note('a\n'), note('abc\n')]);
	alice.setOnline(false);
	for (let i = 0; i < 20; i++) alice.replica.write(PATH, note(`offline ${i}\n`));
	alice.setOnline(true);
	settle();
	expect(pushes.slice(12).map((p) => p.commit.files[0]?.text)).toEqual([note('offline 19\n')]);
	expect(world.server.read(PATH)).toBe(note('offline 19\n'));
});

test('a commit sent once whose parent left the retention window merges again after a full catch-up, and lands once', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n.\n.\nend\n'));
	settle();
	alice.setOnline(false);
	alice.replica.edit(PATH, () => note('ONE\n.\n.\nend\n'));
	for (let round = 0; round < 3; round++) {
		bob.replica.edit(PATH, (text) => (text ?? '').replace('end', `end ${round}`));
		world.net.runFor(QUIET * 5);
	}
	alice.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBe(note('ONE\n.\n.\nend 2 1 0\n'));
	expect(alice.replica.read(PATH)).toBe(world.server.read(PATH));
	expect(alice.replica.position()).toBe(world.server.main());
	expect(alice.replica.stats().unknown).toBe(1);
});
