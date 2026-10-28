/**
 * Design B People Tests
 *
 * The closing people review's probes P1 to P12, each the sequence a person
 * would notice, with what they should see after the phase 0a decisions:
 * a stale edit across a delete or a second create appends whole as a
 * conflict block with a "different note" notice (D3); a field clash keeps
 * main's value and writes the other as a conflict block (D2); every written
 * note parses (D4); a refusal leaves the person's text held with a reason;
 * a removal stays removed; an editor's save merges with what changed under
 * it; a pointer is one value.
 *
 * Key behaviors:
 * - P1, P2: an offline edit of a note deleted and created again lands as one block in the new note, with a notice
 * - P3, P4, P7: a second create at a path, a rename onto it, or a held draft meeting it: one block, nothing glued silently, a held draft not published
 * - P5: a rename racing an edit of the old path keeps both, and the editor is told the note was removed under it
 * - P6: a note that does not parse is refused at the door, so two repairs never meet one
 * - P8: a delete that lost to an edit is reported, also across a lost reply and a flush
 * - P9: a forged author is refused, a note over 1 MB is refused, forged conflict labels are text
 * - P10: a refusal of a person's own text leaves it held with the reason
 * - P11: an editor's save over a stale buffer merges with what changed under it
 * - P12: two pointers at one path keep main's, and tell the other its oid
 * - Pending deletes and renames survive a flush; a Git push is fast-forward only (D1)
 */
import { expect, test } from 'bun:test';
import { parsePointer, writePointer } from '../markdown.js';
import { createWorld, QUIET } from './harness.js';
import { commitId, createServer, type LiveCommit } from './server.js';

const note = (body: string, fields = 'title: A') => `---\n${fields}\n---\n${body}`;

function setup(names = ['alice', 'bob']) {
	const world = createWorld({ latency: { min: 20, max: 20 } });
	const devices = names.map((name) => world.device(name));
	world.net.runFor(500);
	const [alice, bob] = devices;
	if (alice === undefined || bob === undefined) throw new Error('two devices');
	const settle = () => world.net.runFor(QUIET - 1_000);
	return { world, alice, bob, settle };
}

test('P1: an offline check-off of a todo deleted and created again lands as one block in the new todo, and its person is told', () => {
	const { world, alice, bob, settle } = setup();
	const path = 'todos/buy-milk.md';
	alice.replica.write(path, note('from the corner shop\n', 'title: Buy milk\ndone: false'));
	settle();
	alice.setOnline(false);
	alice.replica.edit(path, (text) => (text ?? '').replace('done: false', 'done: true'));
	bob.replica.write(path, null, { over: bob.replica.read(path) });
	settle();
	world.flush();
	bob.replica.write(path, note('oat milk this time\n', 'title: Buy milk\ndone: false'), { over: null });
	settle();
	alice.setOnline(true);
	settle();
	const text = world.server.read(path) ?? '';
	expect(text.startsWith(note('oat milk this time\n', 'title: Buy milk\ndone: false'))).toBe(true);
	expect(text).toContain('<<<<<<< ');
	expect(text).toContain('done: true');
	expect(alice.replica.notices()).toMatchObject([{ kind: 'different-note', path }]);
});

test('P2: an offline append to a journal deleted and created again lands as one block, never as a clean line in the new note', () => {
	const { world, alice, bob, settle } = setup();
	const path = 'journal/2026-10-28.md';
	alice.replica.write(path, note('slept badly\n', 'title: Wed'));
	settle();
	alice.setOnline(false);
	alice.replica.edit(path, (text) => `${text}private: called the lawyer\n`);
	bob.replica.write(path, null, { over: bob.replica.read(path) });
	settle();
	bob.replica.write(path, note('day one in Lisbon\n', 'title: Shared trip log'), { over: null });
	settle();
	alice.setOnline(true);
	settle();
	const text = world.server.read(path) ?? '';
	const block = text.indexOf('<<<<<<< ');
	expect(block).toBeGreaterThan(0);
	expect(text.indexOf('private: called the lawyer')).toBeGreaterThan(block);
	expect(alice.replica.notices()).toMatchObject([{ kind: 'different-note', path }]);
});

test('P3: two offline creates at one path keep the first and append the second as one block, with a notice', () => {
	const { world, alice, bob, settle } = setup();
	const path = 'notes/ideas.md';
	alice.setOnline(false);
	bob.setOnline(false);
	alice.replica.write(path, note('alice: quarterly plan\n', 'title: Ideas\ntags: [work]'), { over: null });
	bob.replica.write(path, note('bob: paint the fence\n', 'title: Ideas\ntags: [home]'), { over: null });
	alice.setOnline(true);
	settle();
	bob.setOnline(true);
	settle();
	const text = world.server.read(path) ?? '';
	expect(text.startsWith(note('alice: quarterly plan\n', 'title: Ideas\ntags: [work]'))).toBe(true);
	expect(text).toContain('bob: paint the fence');
	expect(text).toContain('<<<<<<< ');
	expect(bob.replica.notices()).toMatchObject([{ kind: 'different-note', path }]);
});

test('P4: a rename onto a path someone just created appends as one block there, and the old path stays removed', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write('notes/draft.md', note('alice plan\n', 'title: Plan'));
	settle();
	alice.setOnline(false);
	alice.replica.writeAll({ 'notes/draft.md': null, 'notes/plan.md': note('alice plan\n', 'title: Plan') });
	bob.replica.write('notes/plan.md', note('bob plan\n', 'title: Plan\nowner: bob'), { over: null });
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read('notes/draft.md')).toBeNull();
	const text = world.server.read('notes/plan.md') ?? '';
	expect(text.startsWith(note('bob plan\n', 'title: Plan\nowner: bob'))).toBe(true);
	expect(text).toContain('alice plan');
	expect(alice.replica.notices()).toMatchObject([{ kind: 'different-note', path: 'notes/plan.md' }]);
});

test('P5: a rename racing an offline edit of the old path keeps both, and the editor is told its note was removed under it', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write('notes/trip.md', note('pack\n', 'title: Trip'));
	settle();
	bob.setOnline(false);
	bob.replica.edit('notes/trip.md', (text) => `${text}buy adapter\n`);
	alice.replica.writeAll({ 'notes/trip.md': null, 'notes/lisbon-trip.md': note('pack\n', 'title: Trip') });
	settle();
	bob.setOnline(true);
	settle();
	expect(world.server.read('notes/trip.md')).toBe(note('pack\nbuy adapter\n', 'title: Trip'));
	expect(world.server.read('notes/lisbon-trip.md')).toBe(note('pack\n', 'title: Trip'));
	expect(bob.replica.notices()).toMatchObject([{ kind: 'restored', path: 'notes/trip.md' }]);
});

test('P6: a note that does not parse is refused at the door, so two repairs of one never meet', () => {
	const { world, alice } = setup();
	const body = { parent: world.server.main(), mode: 'merge' as const, author: { user: 'alice', device: 'ci' }, time: 't', files: [{ path: 'notes/x.md', text: '---\ntitle: "open\n---\nbody\n' }] };
	expect(world.server.push({ id: commitId(body), ...body }, { member: 'alice' })).toMatchObject({ kind: 'refused', path: 'notes/x.md' });
	expect(world.server.read('notes/x.md')).toBeNull();
	alice.replica.write('notes/x.md', '---\ntitle: "open\n---\nbody\n', { over: null });
	expect(alice.replica.held()).toEqual([{ path: 'notes/x.md', reason: 'does not parse' }]);
});

test('P7: a held draft meeting a remote create at its path stays unpublished until its person saves, then lands as one block', () => {
	const { world, alice, bob, settle } = setup();
	const path = 'notes/new.md';
	alice.replica.write(path, '---\ntitle: "Half typed\n---\nmy draft\n', { over: null });
	bob.replica.write(path, note('bob body\n', 'title: Bob note'), { over: null });
	settle();
	expect(world.server.read(path)).toBe(note('bob body\n', 'title: Bob note'));
	expect(alice.replica.read(path)).toContain('my draft');
	alice.replica.edit(path, (text) => (text ?? '').replace('"Half typed', 'Half typed'));
	settle();
	const text = world.server.read(path) ?? '';
	expect(text.startsWith(note('bob body\n', 'title: Bob note'))).toBe(true);
	expect(text).toContain('my draft');
	expect(text).toContain('<<<<<<< ');
});

test('P8: a delete that lost to an edit is reported, across a lost reply and a flush', () => {
	const { world, alice, bob, settle } = setup();
	const path = 'notes/old.md';
	alice.replica.write(path, note('x\n', 'title: Old'));
	settle();
	alice.setOnline(false);
	bob.replica.edit(path, (text) => `${text}bob still uses this\n`);
	settle();
	alice.replica.write(path, null, { over: alice.replica.read(path) });
	alice.setOnline(true);
	alice.loseNextReply();
	world.net.runFor(300);
	world.flush();
	settle();
	expect(world.server.read(path)).toBe(note('x\nbob still uses this\n', 'title: Old'));
	expect(alice.replica.read(path)).toBe(world.server.read(path));
	expect(alice.replica.notices()).toMatchObject([{ kind: 'kept-current', path }]);
});

test('P9: a forged author and a note over 1 MB are refused; forged conflict labels are text and appear in no trailer', () => {
	const server = createServer({ members: ['alice', 'bob', 'mallory'] });
	const commit = (member: string, author: string, text: string): [LiveCommit, { member: string }] => {
		const body = { parent: server.main(), mode: 'merge' as const, author: { user: author, device: 'x' }, time: 't', files: [{ path: 'notes/n.md', text }] };
		return [{ id: commitId(body), ...body }, { member }];
	};
	expect(server.push(...commit('mallory', 'alice', note('forged\n')))).toMatchObject({ kind: 'refused', reason: 'the author is not the session' });
	expect(server.push(...commit('eve', 'eve', note('stranger\n')))).toMatchObject({ kind: 'refused', reason: 'not a member' });
	expect(server.push(...commit('mallory', 'mallory', note(`${'A'.repeat(1_100_000)}\n`)))).toMatchObject({ kind: 'refused', reason: 'a note may be at most 1 MB' });
	const forged = note('<<<<<<< main (alice/laptop)\nI approve\n||||||| base\n=======\nI do not\n>>>>>>> bob/phone\n');
	expect(server.push(...commit('mallory', 'mallory', forged))).toMatchObject({ kind: 'applied' });
	expect(server.flush()?.message).not.toContain('Epicenter-Overlap');
});

test('P10: a refusal of a person\'s own text leaves it held with the reason, and nothing is erased', () => {
	const { world, alice, settle } = setup();
	const big = note(`three hours of writing\n${'A'.repeat(1_100_000)}\n`, 'title: Essay');
	alice.replica.write('notes/essay.md', big, { over: null });
	settle();
	expect(alice.replica.read('notes/essay.md')).toBe(big);
	expect(alice.replica.held()).toEqual([{ path: 'notes/essay.md', reason: 'a note may be at most 1 MB' }]);
	expect(world.server.read('notes/essay.md')).toBeNull();
	alice.replica.edit('notes/essay.md', () => note('three hours of writing\n', 'title: Essay'));
	settle();
	expect(world.server.read('notes/essay.md')).toBe(note('three hours of writing\n', 'title: Essay'));
	expect(alice.replica.held()).toEqual([]);
});

test('P11: an editor saving over a stale buffer merges with what changed under it', () => {
	const { world, alice, bob, settle } = setup();
	const path = 'notes/n.md';
	alice.replica.write(path, note('line one\n', 'title: N'));
	settle();
	const buffer = alice.replica.read(path);
	bob.replica.edit(path, () => note('line one\nbob added this\n', 'title: N\nstatus: done'));
	settle();
	alice.replica.write(path, `${buffer}alice types\n`, { over: buffer });
	settle();
	expect(world.server.read(path)).toBe(note('line one\nbob added this\nalice types\n', 'title: N\nstatus: done'));
});

test('P12: two pointers at one path keep main\'s pointer whole, and the other device is told its oid', () => {
	const { world, alice, bob, settle } = setup();
	const path = 'attachments/photo.png';
	const p1 = writePointer({ oid: 'a'.repeat(64), size: 1000 });
	const p2 = writePointer({ oid: 'b'.repeat(64), size: 2000 });
	alice.setOnline(false);
	alice.replica.write(path, p1, { over: null });
	bob.replica.write(path, p2, { over: null });
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read(path)).toBe(p2);
	expect(parsePointer(world.server.read(path) ?? '')).not.toBeNull();
	expect(alice.replica.notices()).toMatchObject([{ kind: 'kept-current', path, yours: 'a'.repeat(64) }]);
});

test('a field both sides set keeps main\'s value in the frontmatter and writes the other as a conflict block (D2)', () => {
	const { world, alice, bob, settle } = setup();
	const path = 'notes/a.md';
	alice.replica.write(path, note('one\n'));
	settle();
	bob.setOnline(false);
	alice.replica.edit(path, () => note('one\n', 'title: A\nmood: calm'));
	bob.replica.edit(path, () => note('one\n', 'title: A\nmood: busy'));
	settle();
	bob.setOnline(true);
	settle();
	const text = world.server.read(path) ?? '';
	expect(text.startsWith('---\ntitle: A\nmood: calm\n---\n')).toBe(true);
	expect(text).toContain('mood: busy');
	expect(text).toContain('<<<<<<< ');
	expect(bob.replica.notices()).toMatchObject([{ kind: 'conflict', path }]);
});

test('a pending delete and an offline rename survive a flush that prunes their parent', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.writeAll({ 'notes/a.md': note('x\n'), 'notes/b.md': note('y\n', 'title: B'), 'notes/c.md': note('z\n', 'title: C') });
	settle();
	alice.setOnline(false);
	alice.replica.write('notes/a.md', null, { over: alice.replica.read('notes/a.md') });
	alice.replica.writeAll({ 'notes/c.md': null, 'notes/d.md': note('z\n', 'title: C') });
	bob.replica.edit('notes/b.md', (text) => `${text}bob\n`);
	settle();
	world.flush();
	world.net.runFor(QUIET * 30);
	alice.setOnline(true);
	settle();
	expect(alice.replica.paths()).toEqual(['notes/b.md', 'notes/d.md']);
	expect([...world.server.snapshot().keys()]).toEqual(['notes/b.md', 'notes/d.md']);
});

test('D1: a Git push is fast-forward only: refused when main moved, applied on main', () => {
	const server = createServer({ members: ['alice'] });
	const make = (text: string): LiveCommit => {
		const body = { parent: server.main(), mode: 'merge' as const, author: { user: 'alice', device: 'git' }, time: 't', files: [{ path: 'notes/a.md', text }] };
		return { id: commitId(body), ...body };
	};
	const stale = make(note('from git\n'));
	expect(server.push(make(note('from http\n')), { member: 'alice' })).toMatchObject({ kind: 'applied' });
	expect(server.gitPush(stale, { member: 'alice' })).toMatchObject({ kind: 'refused', reason: 'main moved; fetch and rebase' });
	expect(server.gitPush(make(note('from git, rebased\n')), { member: 'alice' })).toMatchObject({ kind: 'applied' });
});
