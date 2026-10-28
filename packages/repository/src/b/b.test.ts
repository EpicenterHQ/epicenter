/**
 * Design B Scenario Tests
 *
 * The intent of today's engine's held, reconcile, verdict and delete/reuse
 * tests, asserted under design B's rules, plus the cases where B behaves
 * differently on purpose and the rules the deciding test found it needs.
 * Each world has a fixed latency and no loss unless a test loses a reply.
 *
 * Key behaviors:
 * - A text that would break a parsing note is saved and held, never sent; a repair sends exactly the repaired text from the server's
 * - Held text survives a change from elsewhere (rebased), a restart, and an acknowledgment of an earlier write
 * - B: held text over a remote delete is sent as a new note, since a new note breaks nothing; over a path reused by another note it becomes a sibling
 * - A merge that makes held text parse sends it at once
 * - A lost reply needs no receipt: the catch-up finds the write landed, with no second write and no conflict with itself
 * - A write never sends back as its own an edit made elsewhere, and a late reply never moves a base back
 * - For people a delete loses to an edit it had not seen; a note brought back that way takes later unseen edits of it
 * - A stale edit of a note deleted and replaced (also by one with the same text) becomes a sibling, once, and the new note stays
 * - B: a rename racing an edit of the old path leaves both files, with a notice
 * - An agent's stale write is refused and changes nothing; a write with no condition, or one that breaks parsing, is refused by the server
 */
import { expect, test } from 'bun:test';
import { gitBlobHash } from '../hash.js';
import { parses } from '../markdown.js';
import { createWorld } from './harness.js';
import type { Request } from './replica.js';
import { createServer } from './server.js';

const PATH = 'notes/a.md';
const note = (body: string, title = 'A') => `---\ntitle: ${title}\n---\n${body}`;
/** Frontmatter that does not parse: a key given twice. */
const broken = (body: string, title = 'A') => `---\ntitle: ${title}\ntitle: B\n---\n${body}`;

function setup(names = ['alice', 'bob']) {
	const world = createWorld({ latency: { min: 20, max: 20 } });
	const writes: { device: string; request: Extract<Request, { type: 'write' }> }[] = [];
	world.onRequest((device, request) => {
		if (request.type === 'write') writes.push({ device, request });
	});
	const devices = names.map((name) => world.device(name));
	world.settle();
	/** Every text a device ever sent for a path. */
	const sent = (device: string, path: string) =>
		writes.filter((w) => w.device === device).flatMap((w) => w.request.files.filter((f) => f.path === path).map((f) => f.text));
	return { world, devices, writes, sent, settle: () => expect(world.settle()).toBe(true) };
}

// ============================================================================
// Held text (held.test.ts)
// ============================================================================

test('a text that would break a note that parses is saved and held, not refused and not sent', () => {
	const { world, devices: [alice], sent, settle } = setup(['alice']);
	alice?.replica.write({ [PATH]: note('one\n') });
	settle();
	alice?.replica.write({ [PATH]: broken('one\n') });
	settle();
	expect(alice?.replica.read(PATH)).toBe(broken('one\n'));
	expect(alice?.replica.held()).toEqual([PATH]);
	expect(world.server.read(PATH)).toBe(note('one\n'));
	expect(sent('alice', PATH).every((text) => text === null || parses(text))).toBe(true);
});

test('held text survives an acknowledgment, a change from elsewhere and a restart, and a repair sends exactly the repaired text', () => {
	const { world, devices: [alice, bob], writes, settle } = setup();
	if (alice === undefined || bob === undefined) throw new Error('two devices');
	alice.replica.write({ [PATH]: note('one\n.\n.\nbob\n') });
	settle();
	// P goes, and U, which does not parse, is typed while P is in flight.
	alice.replica.write({ [PATH]: note('ONE\n.\n.\nbob\n') });
	world.net.runFor(5);
	alice.replica.write({ [PATH]: broken('ONE\n.\n.\nbob\n') });
	settle();
	expect(world.server.read(PATH)).toBe(note('ONE\n.\n.\nbob\n'));
	expect(alice.replica.held()).toEqual([PATH]);
	bob.replica.write({ [PATH]: note('ONE\n.\n.\nBOB\n') });
	settle();
	expect(alice.replica.read(PATH)).toBe(broken('ONE\n.\n.\nBOB\n'));
	alice.restart();
	settle();
	expect(alice.replica.read(PATH)).toBe(broken('ONE\n.\n.\nBOB\n'));
	expect(alice.replica.held()).toEqual([PATH]);
	const before = writes.length;
	alice.replica.write({ [PATH]: note('ONE\n.\n.\nBOB\n', 'B') });
	settle();
	expect(writes.slice(before).map((w) => w.request.files)).toEqual([
		[{ path: PATH, expected: gitBlobHash(note('ONE\n.\n.\nBOB\n')), text: note('ONE\n.\n.\nBOB\n', 'B'), note: 1 }],
	]);
	expect(world.server.read(PATH)).toBe(note('ONE\n.\n.\nBOB\n', 'B'));
});

test('B: held text over a remote delete is sent as a new note, because a new note breaks nothing', () => {
	const { world, devices: [alice, bob], settle } = setup();
	alice?.replica.write({ [PATH]: note('one\n') });
	settle();
	alice?.setOnline(false);
	alice?.replica.write({ [PATH]: broken('one\n') });
	bob?.replica.write({ [PATH]: null });
	settle();
	alice?.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBe(broken('one\n'));
	expect(alice?.replica.notices()).toEqual([{ kind: 'restored', path: PATH }]);
});

test('B: held text over a path reused by another note becomes a sibling, and the new note stays', () => {
	const { world, devices: [alice, bob], settle } = setup();
	alice?.replica.write({ [PATH]: note('one\n') });
	settle();
	alice?.setOnline(false);
	alice?.replica.write({ [PATH]: broken('one\n') });
	bob?.replica.write({ [PATH]: null });
	settle();
	bob?.replica.write({ [PATH]: note('reused\n', 'R') });
	settle();
	alice?.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBe(note('reused\n', 'R'));
	expect(world.server.read('notes/a (alice, 2026-10-28).md')).toBe(broken('one\n'));
	expect(alice?.replica.notices()).toEqual([{ kind: 'sibling', path: 'notes/a (alice, 2026-10-28).md', of: PATH }]);
});

test('a merge that makes held text parse sends it at once', () => {
	const { world, devices: [alice, bob], settle } = setup();
	alice?.replica.write({ [PATH]: note('one\n') });
	settle();
	alice?.replica.write({ [PATH]: broken('one\n') });
	// Bob removes the title Alice gave twice, which leaves hers once.
	bob?.replica.write({ [PATH]: '---\n---\none\n' });
	settle();
	expect(world.server.read(PATH)).toBe('---\ntitle: B\n---\none\n');
	expect(alice?.replica.held()).toEqual([]);
});

// ============================================================================
// Lost replies (verdict.test.ts) and starting points (reconcile.test.ts)
// ============================================================================

test('a lost reply needs no receipt: the catch-up finds the write landed, and it is not sent again', () => {
	const { world, devices: [alice], sent, settle } = setup(['alice']);
	alice?.replica.write({ [PATH]: note('one\n') });
	settle();
	alice?.loseNextReply();
	alice?.replica.write({ [PATH]: note('two\n') });
	settle();
	expect(world.server.read(PATH)).toBe(note('two\n'));
	expect(sent('alice', PATH)).toEqual([note('one\n'), note('two\n')]);
	expect(alice?.replica.files().get(PATH)).toEqual({ base: note('two\n'), mine: note('two\n'), gone: false });
});

test('a lost reply, more typing on the same line, and an edit elsewhere merge with no conflict with itself', () => {
	const { world, devices: [alice, bob], settle } = setup();
	alice?.replica.write({ [PATH]: note('one\n.\n.\nbob\n') });
	settle();
	alice?.loseNextReply();
	alice?.replica.write({ [PATH]: note('one two\n.\n.\nbob\n') });
	world.net.runFor(100);
	alice?.replica.write({ [PATH]: note('one two three\n.\n.\nbob\n') });
	bob?.replica.write({ [PATH]: note('one two\n.\n.\nBOB\n') });
	settle();
	expect(world.server.read(PATH)).toBe(note('one two three\n.\n.\nBOB\n'));
	expect(alice?.replica.read(PATH)).toBe(note('one two three\n.\n.\nBOB\n'));
});

test('a write in flight when an edit elsewhere lands is merged and sent again, never sending that edit back as its own', () => {
	const { world, devices: [alice, bob], writes, settle } = setup();
	alice?.replica.write({ [PATH]: note('one\n.\n.\nb0\n') });
	settle();
	bob?.replica.write({ [PATH]: note('one\n.\n.\nb1\n') });
	world.net.runFor(5);
	alice?.replica.write({ [PATH]: note('one\n.\n.\nb0\n', 'T1') });
	settle();
	expect(world.server.read(PATH)).toBe(note('one\n.\n.\nb1\n', 'T1'));
	expect(alice?.replica.notices()).toEqual([]);
	// Alice's retry starts from Bob's text: it sends his line unchanged, as what she expected.
	const last = writes.filter((w) => w.device === 'alice').at(-1)?.request.files[0];
	expect(last?.expected).toBe(gitBlobHash(note('one\n.\n.\nb1\n')));
});

test('a lost reply followed by an edit elsewhere ends with the base at the server, not at the text sent', () => {
	const world = createWorld({ latency: { min: 20, max: 20 }, timeout: 100 });
	const alice = world.device('alice');
	const bob = world.device('bob');
	world.settle();
	alice.replica.write({ [PATH]: note('one\n') });
	world.settle();
	// Alice's reply is lost, she times out and catches up; meanwhile Bob adds a line.
	alice.loseNextReply();
	alice.replica.write({ [PATH]: note('two\n') });
	world.net.runFor(60);
	bob.replica.write({ [PATH]: note('one\nbob\n') });
	expect(world.settle()).toBe(true);
	expect(alice.replica.files().get(PATH)).toEqual({ base: note('two\nbob\n'), mine: note('two\nbob\n'), gone: false });
});

// ============================================================================
// Deletes and reused paths (e2e.test.ts)
// ============================================================================

test('for people, a delete versus an edit keeps the edit, and the deleter is told', () => {
	const { world, devices: [alice, bob], settle } = setup();
	alice?.replica.write({ 'notes/keep.md': 'v1\n' });
	settle();
	alice?.setOnline(false);
	alice?.replica.write({ 'notes/keep.md': null });
	bob?.replica.write({ 'notes/keep.md': 'v2\n' });
	settle();
	alice?.setOnline(true);
	settle();
	expect(world.server.read('notes/keep.md')).toBe('v2\n');
	expect(alice?.replica.read('notes/keep.md')).toBe('v2\n');
	expect(alice?.replica.notices()).toEqual([{ kind: 'kept', path: 'notes/keep.md' }]);
});

test('a note brought back by an unseen edit is the same note, so a later unseen edit merges into it (bug A)', () => {
	const { world, devices: [alice, bob, carol], settle } = setup(['alice', 'bob', 'carol']);
	alice?.replica.write({ 'notes/n.md': 'v1\n' });
	settle();
	bob?.setOnline(false);
	carol?.setOnline(false);
	bob?.replica.write({ 'notes/n.md': 'v1 bob\n' });
	carol?.replica.write({ 'notes/n.md': 'carol v1\n' });
	alice?.replica.write({ 'notes/n.md': null });
	settle();
	bob?.setOnline(true);
	settle();
	carol?.setOnline(true);
	settle();
	expect(world.server.snapshot()).toEqual(new Map([['notes/n.md', 'carol v1 bob\n']]));
	expect(bob?.replica.notices()).toEqual([{ kind: 'restored', path: 'notes/n.md' }]);
});

test('an offline edit to a note deleted and created again becomes a sibling, and the new note stays (bug B)', () => {
	const { world, devices: [alice, bob], settle } = setup();
	alice?.replica.write({ 'notes/log.md': 'old log\n' });
	settle();
	bob?.setOnline(false);
	bob?.replica.write({ 'notes/log.md': 'old log\nbob\n' });
	alice?.replica.write({ 'notes/log.md': null });
	settle();
	world.server.commit();
	alice?.replica.write({ 'notes/log.md': 'new log\n' });
	settle();
	bob?.setOnline(true);
	settle();
	expect(bob?.replica.notices()).toEqual([{ kind: 'sibling', path: 'notes/log (bob, 2026-10-28).md', of: 'notes/log.md' }]);
	expect(world.server.snapshot()).toEqual(
		new Map([
			['notes/log (bob, 2026-10-28).md', 'old log\nbob\n'],
			['notes/log.md', 'new log\n'],
		]),
	);
});

test('two offline edits of a replaced note land in one sibling, and the device is told once', () => {
	const { world, devices: [alice, bob], settle } = setup();
	alice?.replica.write({ 'notes/plan.md': 'old plan\n' });
	settle();
	bob?.setOnline(false);
	bob?.replica.write({ 'notes/plan.md': 'old plan\nbob one\n' });
	bob?.replica.write({ 'notes/plan.md': 'old plan\nbob one\nbob two\n' });
	alice?.replica.write({ 'notes/plan.md': null });
	settle();
	alice?.replica.write({ 'notes/plan.md': 'a different plan\n' });
	settle();
	bob?.setOnline(true);
	settle();
	expect(bob?.replica.notices()).toHaveLength(1);
	expect(world.server.read('notes/plan.md')).toBe('a different plan\n');
	expect(world.server.read('notes/plan (bob, 2026-10-28).md')).toBe('old plan\nbob one\nbob two\n');
});

test('a stale edit of a note replaced by one with the very same text becomes a sibling: a hash alone cannot tell them apart', () => {
	const template = '---\ntitle: New\n---\n';
	const { world, devices: [alice, bob], settle } = setup();
	alice?.replica.write({ [PATH]: template });
	settle();
	bob?.setOnline(false);
	bob?.replica.write({ [PATH]: `${template}bob's notes\n` });
	alice?.replica.write({ [PATH]: null });
	settle();
	alice?.replica.write({ [PATH]: template });
	settle();
	bob?.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBe(template);
	expect(world.server.read('notes/a (bob, 2026-10-28).md')).toBe(`${template}bob's notes\n`);
});

test('B: a rename racing an edit of the old path leaves both files, and the renamer is told', () => {
	const { world, devices: [alice, bob], settle } = setup();
	alice?.replica.write({ [PATH]: note('one\n') });
	settle();
	alice?.setOnline(false);
	alice?.replica.write({ [PATH]: null, 'notes/b.md': note('one\n') });
	bob?.replica.write({ [PATH]: note('one\nbob\n') });
	settle();
	alice?.setOnline(true);
	settle();
	expect(world.server.snapshot()).toEqual(
		new Map([
			[PATH, note('one\nbob\n')],
			['notes/b.md', note('one\n')],
		]),
	);
	expect(alice?.replica.notices()).toEqual([{ kind: 'kept', path: PATH }]);
});

test('a field both devices set keeps the value that landed first, and the device whose value was kept out is told', () => {
	const { world, devices: [alice, bob], settle } = setup();
	alice?.replica.write({ [PATH]: note('one\n') });
	settle();
	bob?.setOnline(false);
	alice?.replica.write({ [PATH]: `---\ntitle: A\nmood: calm\n---\none\n` });
	bob?.replica.write({ [PATH]: `---\ntitle: A\nmood: busy\n---\none\n` });
	settle();
	bob?.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBe(`---\ntitle: A\nmood: calm\n---\none\n`);
	expect(bob?.replica.notices()).toEqual([{ kind: 'field', path: PATH, key: 'mood', yours: 'busy', kept: 'calm' }]);
});

// ============================================================================
// Agents and the server's refusals
// ============================================================================

test("an agent's stale write is refused and changes nothing; its clean write applies", () => {
	const world = createWorld({ latency: { min: 20, max: 20 } });
	const alice = world.device('alice');
	const agent = world.device('agent', { mode: 'agent' });
	world.settle();
	alice.replica.write({ [PATH]: note('one\n') });
	world.settle();
	alice.replica.write({ [PATH]: note('one\nalice\n') });
	world.net.runFor(5);
	agent.replica.write({ [PATH]: note('one\nagent\n') });
	world.settle();
	expect(world.server.read(PATH)).toBe(note('one\nalice\n'));
	expect(agent.replica.refusals()).toEqual([{ paths: [PATH], reason: 'stale' }]);
	expect(agent.replica.read(PATH)).toBe(note('one\nalice\n'));
	agent.replica.write({ [PATH]: note('one\nalice\nagent\n') });
	world.settle();
	expect(world.server.read(PATH)).toBe(note('one\nalice\nagent\n'));
});

test('the server refuses a write with no condition, one that breaks parsing, and one that names a path twice, and changes nothing', () => {
	const server = createServer();
	expect(server.write('x', [{ path: PATH, expected: null, text: note('one\n') }])).toMatchObject({ kind: 'applied' });
	const unconditioned = [{ path: PATH, text: 'blind\n' }] as unknown as Parameters<typeof server.write>[1];
	expect(server.write('x', unconditioned)).toEqual({ kind: 'precondition-required', path: PATH });
	expect(server.write('x', [{ path: PATH, expected: gitBlobHash(note('one\n')), text: broken('one\n') }])).toMatchObject({ kind: 'refused' });
	expect(
		server.write('x', [
			{ path: 'notes/b.md', expected: null, text: 'b\n' },
			{ path: 'notes/b.md', expected: null, text: 'c\n' },
		]),
	).toMatchObject({ kind: 'refused' });
	expect(server.snapshot()).toEqual(new Map([[PATH, note('one\n')]]));
});

test('a conditional write of several files is all or nothing', () => {
	const server = createServer();
	server.write('x', [{ path: PATH, expected: null, text: 'a\n' }]);
	expect(
		server.write('x', [
			{ path: 'notes/b.md', expected: null, text: 'b\n' },
			{ path: PATH, expected: gitBlobHash('old\n'), text: 'a2\n' },
		]),
	).toMatchObject({ kind: 'stale', files: [{ path: PATH, text: 'a\n' }] });
	expect(server.snapshot()).toEqual(new Map([[PATH, 'a\n']]));
});
