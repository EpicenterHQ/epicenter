/**
 * Design B Scenario Tests
 *
 * The intent of today's engine's held, reconcile, verdict and delete/reuse
 * tests, asserted under collapsed design B: live commits with parents, the
 * server merging merge-mode commits into whatever is at the path, the commit
 * id as idempotency, a commit on every save, the flush, and pruning live
 * history after it. Each world has a fixed latency and no loss unless a test
 * loses a reply.
 *
 * Key behaviors:
 * - A text that would break a parsing note is held, never committed; a repair commits exactly the repaired text
 * - Held text survives a change from elsewhere (rebased) and a restart; a merge that makes it parse commits it
 * - Held text over a remote delete stays held (a missing file below must parse); over a path reused by another note it joins that note, visibly
 * - A lost reply is answered by resending the same commit, which lands once; typing since never conflicts with itself
 * - A commit whose outcome left with a flush rebuilds its overlap notice from the flush's trailers
 * - A commit meeting a moved `main` is merged by the server in one push; the device never sends an edit made elsewhere back as its own
 * - For people a delete loses to an edit it had not seen, and a later unseen edit merges into the note brought back
 * - Changed: an edit of a note deleted and replaced merges into the note there now (lines or conflict markers); nothing is lost
 * - A commit whose parent was pruned is merged again on top here and committed once more; a position older than kept history catches up by a full snapshot
 * - A rename racing an edit of the old path leaves both files, with a notice
 * - An agent's fast-forward commit is refused when `main` moved and changes nothing; the server refuses commits with no parent, a bad id, or a path named twice
 * - Every save commits while online; while a commit is in flight or offline, saves amend one unsent commit; a sent commit is never rewritten
 * - A flush writes the design's commit message
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
	alice.replica.write({ [PATH]: note('one\n') });
	settle();
	alice.replica.write({ [PATH]: broken('one\n') });
	settle();
	expect(alice.replica.read(PATH)).toBe(broken('one\n'));
	expect(alice.replica.held()).toEqual([PATH]);
	expect(world.server.read(PATH)).toBe(note('one\n'));
	expect(sent('alice', PATH).every((text) => text === null || parses(text))).toBe(true);
});

test('held text survives a change from elsewhere and a restart, and a repair commits exactly the repaired text', () => {
	const { world, alice, bob, pushes, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n.\n.\nbob\n') });
	settle();
	alice.replica.write({ [PATH]: broken('ONE\n.\n.\nbob\n') });
	bob.replica.write({ [PATH]: note('one\n.\n.\nBOB\n') });
	settle();
	expect(alice.replica.read(PATH)).toBe(broken('ONE\n.\n.\nBOB\n'));
	alice.restart();
	settle();
	expect(alice.replica.read(PATH)).toBe(broken('ONE\n.\n.\nBOB\n'));
	expect(alice.replica.held()).toEqual([PATH]);
	const before = pushes.length;
	alice.replica.write({ [PATH]: note('ONE\n.\n.\nBOB\n', 'B') });
	settle();
	expect(pushes.slice(before).map((p) => p.commit.files)).toEqual([[{ path: PATH, text: note('ONE\n.\n.\nBOB\n', 'B') }]]);
	expect(world.server.read(PATH)).toBe(note('ONE\n.\n.\nBOB\n', 'B'));
});

test('changed: held text over a remote delete stays held, because a missing file below counts as one that must parse', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n') });
	settle();
	alice.setOnline(false);
	alice.replica.write({ [PATH]: broken('one\n') });
	bob.replica.write({ [PATH]: null });
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBeNull();
	expect(alice.replica.held()).toEqual([PATH]);
	alice.replica.write({ [PATH]: note('one\nkept\n') });
	settle();
	expect(world.server.read(PATH)).toBe(note('one\nkept\n'));
	expect(alice.replica.notices()).toEqual([{ kind: 'restored', path: PATH }]);
});

test('held text over a path reused by another note stays held, and merges into that note visibly; its repair commits both', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n') });
	settle();
	alice.setOnline(false);
	alice.replica.write({ [PATH]: broken('one\nmine\n') });
	bob.replica.write({ [PATH]: null });
	settle();
	bob.replica.write({ [PATH]: note('reused\n', 'R') });
	settle();
	alice.setOnline(true);
	settle();
	// Offline, the delete and the new note reach Alice as one change to her note: her own edits stay on top of it.
	expect(alice.replica.held()).toEqual([PATH]);
	const shown = alice.replica.read(PATH) ?? '';
	expect(shown).toContain('reused');
	expect(shown).toContain('mine');
	alice.replica.write({ [PATH]: shown.replace('title: B\n', '') });
	settle();
	expect(world.server.read(PATH)).toBe(alice.replica.read(PATH));
	expect(world.server.read(PATH)).toContain('reused');
	expect(world.server.read(PATH)).toContain('mine');
});
test('a merge that makes held text parse commits it', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n') });
	settle();
	alice.replica.write({ [PATH]: broken('one\n') });
	// Bob removes the title Alice gave twice, which leaves hers once.
	bob.replica.write({ [PATH]: '---\n---\none\n' });
	settle();
	expect(world.server.read(PATH)).toBe('---\ntitle: B\n---\none\n');
	expect(alice.replica.held()).toEqual([]);
});

// ============================================================================
// Lost replies (verdict.test.ts) and meeting a moved main (reconcile.test.ts)
// ============================================================================

test('a lost reply is answered by sending the same commit again, which lands once', () => {
	const { world, alice, pushes, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n') });
	settle();
	const commits = world.server.history().commits;
	alice.loseNextReply();
	alice.replica.write({ [PATH]: note('two\n') });
	settle();
	expect(world.server.read(PATH)).toBe(note('two\n'));
	const ids = pushes.map((p) => p.commit.id);
	expect(ids.at(-1)).toBe(ids.at(-2));
	expect(world.server.history().commits).toBe(commits + 1);
	expect(alice.replica.files().get(PATH)).toEqual({ base: note('two\n'), mine: note('two\n'), settled: true });
});

test('a lost reply, more typing on the same line, and an edit elsewhere merge with no conflict with itself', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n.\n.\nbob\n') });
	settle();
	alice.loseNextReply();
	alice.replica.write({ [PATH]: note('one two\n.\n.\nbob\n') });
	world.net.runFor(100);
	alice.replica.write({ [PATH]: note('one two three\n.\n.\nbob\n') });
	bob.replica.write({ [PATH]: (bob.replica.read(PATH) ?? '').replace('bob\n', 'BOB\n') });
	settle();
	expect(world.server.read(PATH)).toBe(note('one two three\n.\n.\nBOB\n'));
	expect(alice.replica.read(PATH)).toBe(note('one two three\n.\n.\nBOB\n'));
});

test('a commit whose outcome left with a flush rebuilds its overlap notice from the trailers', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n') });
	settle();
	alice.setOnline(false);
	alice.replica.write({ [PATH]: note('three\n') });
	bob.replica.write({ [PATH]: note('two\n') });
	settle();
	alice.loseNextReply();
	alice.setOnline(true);
	world.net.runFor(300);
	const flushed = world.flush();
	expect(flushed?.message).toMatch(/Epicenter-Overlap: notes\/a\.md body \(bob\/bob, alice\/alice\) in [0-9a-f]{7}/);
	settle();
	expect(alice.replica.notices()).toEqual([{ kind: 'overlap', path: PATH, unit: 'body' }]);
	expect(alice.replica.read(PATH)).toBe(world.server.read(PATH));
	expect(world.server.read(PATH)).toContain('<<<<<<< main (bob/bob)');
});

test('a commit meeting a moved main is merged by the server in one push, and sends no edit made elsewhere back as its own', () => {
	const { world, alice, bob, pushes, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n.\n.\nb0\n') });
	settle();
	bob.replica.write({ [PATH]: note('one\n.\n.\nb1\n') });
	world.net.runFor(5);
	alice.replica.write({ [PATH]: note('one\n.\n.\nb0\n', 'T1') });
	settle();
	expect(world.server.read(PATH)).toBe(note('one\n.\n.\nb1\n', 'T1'));
	expect(alice.replica.notices()).toEqual([]);
	const mine = pushes.filter((p) => p.device === 'alice').at(-1)?.commit;
	expect(pushes.filter((p) => p.commit.id === mine?.id)).toHaveLength(1);
	expect(mine?.files).toEqual([{ path: PATH, text: note('one\n.\n.\nb0\n', 'T1') }]);
});

test('typing while a commit is in flight makes a new commit on top of the answer; the sent one is never rewritten', () => {
	const { alice, pushes, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n') });
	alice.replica.write({ [PATH]: note('one\ntwo\n') });
	settle();
	const [first, second] = pushes.map((p) => p.commit);
	expect(first?.files[0]?.text).toBe(note('one\n'));
	expect(second?.parent).toBe(first?.id);
	expect(second?.files[0]?.text).toBe(note('one\ntwo\n'));
});

// ============================================================================
// Deletes and reused paths (e2e.test.ts): identity from history
// ============================================================================

test('for people, a delete versus an edit keeps the edit, and the deleter is told', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ 'notes/keep.md': 'v1\n' });
	settle();
	alice.setOnline(false);
	alice.replica.write({ 'notes/keep.md': null });
	bob.replica.write({ 'notes/keep.md': 'v2\n' });
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read('notes/keep.md')).toBe('v2\n');
	expect(alice.replica.read('notes/keep.md')).toBe('v2\n');
	expect(alice.replica.notices()).toEqual([{ kind: 'kept', path: 'notes/keep.md' }]);
});

test('a note brought back by an unseen edit takes a later unseen edit too (bug A)', () => {
	const { world, alice, bob, carol, settle } = setup(['alice', 'bob', 'carol']);
	alice.replica.write({ 'notes/n.md': 'v1\n' });
	settle();
	bob.setOnline(false);
	carol?.setOnline(false);
	bob.replica.write({ 'notes/n.md': 'v1 bob\n' });
	carol?.replica.write({ 'notes/n.md': 'carol v1\n' });
	alice.replica.write({ 'notes/n.md': null });
	settle();
	bob.setOnline(true);
	settle();
	carol?.setOnline(true);
	settle();
	expect(world.server.snapshot()).toEqual(new Map([['notes/n.md', 'carol v1 bob\n']]));
	expect(bob.replica.notices()).toEqual([{ kind: 'restored', path: 'notes/n.md' }]);
});

test('changed: an offline edit of a note deleted and created again, across flushes, merges into the note there now (bug B)', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ 'notes/log.md': 'old log\n' });
	settle();
	bob.setOnline(false);
	bob.replica.write({ 'notes/log.md': 'old log\nbob\n' });
	alice.replica.write({ 'notes/log.md': null });
	settle();
	world.flush();
	alice.replica.write({ 'notes/log.md': 'new log\n' });
	settle();
	bob.setOnline(true);
	settle();
	expect(world.server.snapshot()).toEqual(new Map([['notes/log.md', 'new log\nbob\n']]));
	expect(bob.replica.read('notes/log.md')).toBe('new log\nbob\n');
});

test('changed: two offline saves of a replaced note go in one commit, and merge into the note there now', () => {
	const { world, alice, bob, pushes, settle } = setup();
	alice.replica.write({ 'notes/plan.md': 'old plan\n' });
	settle();
	bob.setOnline(false);
	bob.replica.write({ 'notes/plan.md': 'old plan\nbob one\n' });
	settle();
	bob.replica.write({ 'notes/plan.md': 'old plan\nbob one\nbob two\n' });
	alice.replica.write({ 'notes/plan.md': null });
	settle();
	alice.replica.write({ 'notes/plan.md': 'a different plan\n' });
	settle();
	const before = pushes.length;
	bob.setOnline(true);
	settle();
	expect(pushes.slice(before).filter((p) => p.device === 'bob')).toHaveLength(1);
	const merged = world.server.read('notes/plan.md') ?? '';
	expect(merged).toContain('a different plan');
	expect(merged).toContain('bob one\nbob two');
	expect(world.server.snapshot().size).toBe(1);
});

test('changed: an edit of a note replaced by one with the very same text merges into the new note cleanly, nothing lost', () => {
	const template = '---\ntitle: New\n---\n';
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ [PATH]: template });
	settle();
	bob.setOnline(false);
	bob.replica.write({ [PATH]: `${template}bob's notes\n` });
	alice.replica.write({ [PATH]: null });
	settle();
	alice.replica.write({ [PATH]: template });
	settle();
	bob.setOnline(true);
	settle();
	expect(world.server.snapshot()).toEqual(new Map([[PATH, `${template}bob's notes\n`]]));
});

test('a rename racing an edit of the old path leaves both files, and the renamer is told', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n') });
	settle();
	alice.setOnline(false);
	alice.replica.write({ [PATH]: null, 'notes/b.md': note('one\n') });
	bob.replica.write({ [PATH]: note('one\nbob\n') });
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.snapshot()).toEqual(
		new Map([
			[PATH, note('one\nbob\n')],
			['notes/b.md', note('one\n')],
		]),
	);
	expect(alice.replica.notices()).toEqual([{ kind: 'kept', path: PATH }]);
});

test('a field both devices set keeps the value that landed first, and the device whose value was kept out is told', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n') });
	settle();
	bob.setOnline(false);
	alice.replica.write({ [PATH]: '---\ntitle: A\nmood: calm\n---\none\n' });
	bob.replica.write({ [PATH]: '---\ntitle: A\nmood: busy\n---\none\n' });
	settle();
	bob.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBe('---\ntitle: A\nmood: calm\n---\none\n');
	expect(bob.replica.notices()).toEqual([{ kind: 'field', path: PATH, key: 'mood', yours: 'busy', kept: 'calm' }]);
});

// ============================================================================
// Agents, the server's refusals, cadence and the flush
// ============================================================================

test("an agent's fast-forward commit is refused when main moved and changes nothing; on main it applies, and merge mode is merged", () => {
	const world = createWorld({ latency: { min: 20, max: 20 } });
	const alice = world.device('alice');
	const agent = world.device('agent', { mode: 'fast-forward' });
	world.net.runFor(500);
	alice.replica.write({ [PATH]: note('one\n') });
	world.net.runFor(500);
	alice.replica.write({ [PATH]: note('one\nalice\n') });
	world.net.runFor(5);
	agent.replica.write({ [PATH]: note('one\nagent\n') });
	world.net.runFor(2_000);
	expect(world.server.read(PATH)).toBe(note('one\nalice\n'));
	expect(agent.replica.refusals()).toEqual([{ paths: [PATH], reason: 'main moved' }]);
	expect(agent.replica.read(PATH)).toBe(note('one\nalice\n'));
	agent.replica.write({ [PATH]: note('one\nalice\nagent\n') });
	world.net.runFor(2_000);
	expect(world.server.read(PATH)).toBe(note('one\nalice\nagent\n'));
	alice.replica.write({ [PATH]: note('zero\none\nalice\nagent\n') });
	world.net.runFor(5);
	agent.replica.write({ [PATH]: note('one\nalice\nagent\nagain\n') }, { commitMode: 'merge' });
	world.net.runFor(2_000);
	expect(world.server.read(PATH)).toBe(note('zero\none\nalice\nagent\nagain\n'));
});

test('the server refuses a commit with no parent, a bad id, or a path named twice, and a resend gets the recorded outcome', () => {
	const server = createServer();
	const make = (files: LiveCommit['files'], mode: LiveCommit['mode'] = 'merge'): LiveCommit => {
		const body = { parent: server.main(), mode, author: { user: 'x', device: 'x' }, time: 't', files };
		return { id: commitId(body), ...body };
	};
	const first = make([{ path: PATH, text: note('one\n') }]);
	expect(server.push(first)).toMatchObject({ kind: 'applied', main: first.id });
	expect(server.push(first)).toMatchObject({ kind: 'applied', main: first.id });
	expect(server.history().commits).toBe(1);
	expect(server.push({ ...make([]), parent: undefined } as unknown as LiveCommit)).toEqual({ kind: 'precondition-required' });
	expect(server.push({ ...make([{ path: PATH, text: 'x' }]), id: 'forged' })).toMatchObject({ kind: 'invalid' });
	expect(server.push(make([{ path: 'notes/b.md', text: 'b\n' }, { path: 'notes/b.md', text: 'c\n' }]))).toMatchObject({ kind: 'invalid' });
	expect(server.push(make([{ path: PATH, text: broken('one\n') }], 'fast-forward'))).toMatchObject({ kind: 'refused' });
	expect(server.snapshot()).toEqual(new Map([[PATH, note('one\n')]]));
});

test('every save commits while online; saves while a commit is in flight, or offline, amend one unsent commit', () => {
	const { world, alice, pushes, settle } = setup();
	for (let i = 1; i <= 10; i++) {
		alice.replica.write({ [PATH]: note(`${'x'.repeat(i)}\n`) });
		world.net.runFor(100);
	}
	// A round trip is 40 ms: each save went alone.
	expect(new Set(pushes.map((p) => p.commit.id)).size).toBe(10);
	// Three saves inside one round trip: the first goes, the next two amend one commit.
	alice.replica.write({ [PATH]: note('a\n') });
	alice.replica.write({ [PATH]: note('ab\n') });
	alice.replica.write({ [PATH]: note('abc\n') });
	settle();
	expect(pushes.slice(10).map((p) => p.commit.files[0]?.text)).toEqual([note('a\n'), note('abc\n')]);
	alice.setOnline(false);
	for (let i = 0; i < 20; i++) alice.replica.write({ [PATH]: note(`offline ${i}\n`) });
	alice.setOnline(true);
	settle();
	expect(pushes.slice(12).map((p) => p.commit.files[0]?.text)).toEqual([note('offline 19\n')]);
	expect(world.server.read(PATH)).toBe(note('offline 19\n'));
});

test('a commit whose parent was pruned after two flushes is merged again on top and lands once; the device stands on main', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n.\n.\nend\n') });
	settle();
	alice.setOnline(false);
	alice.replica.write({ [PATH]: note('ONE\n.\n.\nend\n') });
	for (let round = 0; round < 3; round++) {
		bob.replica.write({ [PATH]: (bob.replica.read(PATH) ?? '').replace('end', `end ${round}`) });
		settle();
		world.flush();
	}
	alice.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBe(note('ONE\n.\n.\nend 2 1 0\n'));
	expect(alice.replica.read(PATH)).toBe(world.server.read(PATH));
	expect(alice.replica.position()).toBe(world.server.main());
});

test('a flush writes the subject, the paths, and the live range, overlap (with its live commit) and co-author trailers', () => {
	const { world, alice, bob, pushes, settle } = setup();
	alice.replica.write({ [PATH]: note('one\n'), 'notes/b.md': 'b\n' });
	settle();
	bob.setOnline(false);
	bob.replica.write({ [PATH]: note('three\n') });
	alice.replica.write({ [PATH]: note('two\n') });
	settle();
	bob.setOnline(true);
	settle();
	const bobs = pushes.filter((p) => p.device === 'bob').at(-1)?.commit.id.slice(0, 7);
	const flushed = world.flush();
	const lines = flushed?.message.split('\n') ?? [];
	expect(lines[0]).toBe('Edit notes/a.md and 1 others');
	expect(lines.slice(2, 4)).toEqual(['notes/a.md', 'notes/b.md']);
	expect(lines.find((l) => l.startsWith('Epicenter-Live: '))).toMatch(/^Epicenter-Live: [0-9a-f]{7}\.\.[0-9a-f]{7} \(\d+ commits\)$/);
	expect(lines).toContain(`Epicenter-Overlap: notes/a.md body (alice/alice, bob/bob) in ${bobs}`);
	expect(lines.filter((l) => l.startsWith('Co-authored-by: '))).toEqual(['Co-authored-by: Alice <alice@example.com>', 'Co-authored-by: Bob <bob@example.com>']);
	expect(flushed?.author).toBe('alice');
});
