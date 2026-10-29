/**
 * Design B People Tests
 *
 * The closing people review's probes P1 to P12, each the sequence a person
 * would notice, with what they should see after the phase 0a decisions:
 * a stale edit across a delete or a second create appends whole as one
 * conflict block (D3); a field clash keeps main's value and writes the other
 * as a conflict block (D2); every written note parses (D4); there are no
 * stored notices: what contested is a block in the text, and whatever of a
 * person's the shared text does not hold stays held on their device with a
 * reason (a refusal, a delete that lost to an edit); an editor's save merges
 * with what changed under it; blobs live at paths named by their content.
 *
 * Key behaviors:
 * - P1, P2: an offline edit of a note deleted and created again lands as one block in the new note
 * - P3, P4, P7: a second create at a path, a rename onto it, or a held draft meeting it: one block, nothing glued silently, a held draft not published
 * - P5: a rename racing an edit of the old path keeps both
 * - P6: a note that does not parse is refused at the door, so two repairs never meet one
 * - P8: a delete that lost to an edit stays held on the deleting device, across a lost reply and a flush, until saved again
 * - P9: a forged author is refused, a note over 1 MB is refused, forged conflict labels are text
 * - P10: a refusal of a person's own text leaves it held with the reason
 * - P11: an editor's save over a stale buffer merges with what changed under it
 * - P12: blobs are named by content, so two attachments never meet at one path; a pointer elsewhere, or without its bytes, is held
 * - The door: portable paths, LF-only notes, control files; paths equal after folding are one path; a merge growing a note past 1 MB is held
 * - A flush writes one Git commit per merge that wrote a block; pending deletes and renames survive a flush; a Git push is fast-forward only (D1)
 */
import { expect, test } from 'bun:test';
import { writePointer } from '../core/markdown.js';
import { findConflicts } from '../core/conflict.js';
import { admissible } from '../core/door.js';
import { MAIN } from '../server/git-store.js';
import type { Session } from '../server/server.js';
import { createTestServer, createWorld, EPOCH, QUIET, STAMP, writer } from './harness.js';
import { commitId, type LiveCommit } from '../core/commit.js';

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

test('P1: an offline check-off of a todo deleted and created again lands as one block in the new todo, and its person is told', async () => {
	const { world, alice, bob, settle } = setup();
	const path = 'todos/buy-milk.md';
	alice.replica.write(path, note('from the corner shop\n', 'title: Buy milk\ndone: false'));
	settle();
	alice.setOnline(false);
	alice.replica.edit(path, (text) => (text ?? '').replace('done: false', 'done: true'));
	bob.replica.write(path, null, { over: bob.replica.read(path) });
	settle();
	await world.flush();
	bob.replica.write(path, note('oat milk this time\n', 'title: Buy milk\ndone: false'), { over: null });
	settle();
	alice.setOnline(true);
	settle();
	const text = world.server.read(path) ?? '';
	expect(text.startsWith(note('oat milk this time\n', 'title: Buy milk\ndone: false'))).toBe(true);
	expect(text).toContain('<<<<<<< ');
	expect(text).toContain('done: true');
	expect(findConflicts(text)).toHaveLength(1);
	expect(alice.replica.state(path)).toEqual({ status: 'synced' });
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
	expect(findConflicts(text)).toHaveLength(1);
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
	expect(findConflicts(text)).toHaveLength(1);
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
	expect(findConflicts(text)).toHaveLength(1);
});

test('P5: a rename racing an offline edit of the old path keeps both', () => {
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
});

test('P6: a note that does not parse is refused at the door, so two repairs of one never meet', () => {
	const { world, alice } = setup();
	const body = { parent: world.server.main(), mode: 'merge' as const, author: { user: 'alice', device: 'ci' }, time: STAMP, files: [{ path: 'notes/x.md', text: '---\ntitle: "open\n---\nbody\n' }] };
	expect(world.server.push({ id: commitId(body), ...body }, writer('alice'))).toMatchObject({ kind: 'refused', path: 'notes/x.md' });
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

test('P8 (changed): a delete that lost to an edit leaves the edited note on the deleting device, across a lost reply and a flush; deleting again sends it', async () => {
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
	await world.flush();
	settle();
	expect(world.server.read(path)).toBe(note('x\nbob still uses this\n', 'title: Old'));
	expect(alice.replica.read(path)).toBe(note('x\nbob still uses this\n', 'title: Old'));
	expect(alice.replica.state(path)).toEqual({ status: 'synced' });
	// Deleting again, now over the edit, sends it.
	alice.replica.write(path, null);
	settle();
	expect(world.server.read(path)).toBeNull();
	expect(alice.replica.state(path)).toEqual({ status: 'synced' });
});

test('P9: a forged author and a note over 1 MB are refused; forged conflict labels are only text', async () => {
	const server = createTestServer();
	const members = new Set(['alice', 'bob', 'mallory']);
	const commit = (member: string, author: string, text: string): [LiveCommit, Session] => {
		const body = { parent: server.main(), mode: 'merge' as const, author: { user: author, device: 'x' }, time: STAMP, files: [{ path: 'notes/n.md', text }] };
		return [{ id: commitId(body), ...body }, { user: member, role: members.has(member) ? 'writer' : null }];
	};
	expect(server.push(...commit('mallory', 'alice', note('forged\n')))).toMatchObject({ kind: 'refused', reason: 'the author is not the session' });
	expect(server.push(...commit('eve', 'eve', note('stranger\n')))).toMatchObject({ kind: 'refused', reason: 'not a member' });
	expect(server.push(...commit('mallory', 'mallory', note(`${'A'.repeat(1_100_000)}\n`)))).toMatchObject({ kind: 'refused', reason: 'a note may be at most 1 MB' });
	const forged = note('<<<<<<< main (alice/laptop)\nI approve\n||||||| base\n=======\nI do not\n>>>>>>> bob/phone\n');
	expect(server.push(...commit('mallory', 'mallory', forged))).toMatchObject({ kind: 'applied' });
	expect(await server.flush()).toMatchObject({ kind: 'flushed', commits: [{ author: 'mallory' }] });
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

test('P12: blobs are named by content, so two attachments never meet at one path; a pointer elsewhere, or without its bytes, is held', () => {
	const { world, alice, bob, settle } = setup();
	const a = { oid: 'a'.repeat(64), size: 1000 };
	const b = { oid: 'b'.repeat(64), size: 2000 };
	world.upload(a.oid);
	world.upload(b.oid);
	alice.setOnline(false);
	alice.replica.write(`attachments/${a.oid}.png`, writePointer(a), { over: null });
	bob.replica.write(`attachments/${b.oid}.png`, writePointer(b), { over: null });
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read(`attachments/${a.oid}.png`)).toBe(writePointer(a));
	expect(world.server.read(`attachments/${b.oid}.png`)).toBe(writePointer(b));
	alice.replica.write('attachments/photo.png', writePointer(a), { over: null });
	expect(alice.replica.state('attachments/photo.png')).toEqual({ status: 'held', reason: "a blob's path must be named by its content" });
	const c = { oid: 'c'.repeat(64), size: 10 };
	alice.replica.write(`attachments/${c.oid}.png`, writePointer(c), { over: null });
	settle();
	expect(alice.replica.state(`attachments/${c.oid}.png`)).toEqual({ status: 'held', reason: "the blob's bytes are missing" });
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
	expect(findConflicts(text)).toHaveLength(1);
});

test('a pending delete and an offline rename survive a flush and the window passing', async () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.writeAll({ 'notes/a.md': note('x\n'), 'notes/b.md': note('y\n', 'title: B'), 'notes/c.md': note('z\n', 'title: C') });
	settle();
	alice.setOnline(false);
	alice.replica.write('notes/a.md', null, { over: alice.replica.read('notes/a.md') });
	alice.replica.writeAll({ 'notes/c.md': null, 'notes/d.md': note('z\n', 'title: C') });
	bob.replica.edit('notes/b.md', (text) => `${text}bob\n`);
	settle();
	await world.flush();
	world.net.runFor(QUIET * 30);
	await world.flush();
	alice.setOnline(true);
	settle();
	expect(alice.replica.paths()).toEqual(['notes/b.md', 'notes/d.md']);
	expect([...world.server.snapshot().keys()]).toEqual(['notes/b.md', 'notes/d.md']);
});

test('D1: a Git push is fast-forward only: refused while live edits are not in Git or when main moved, applied on the flushed main', async () => {
	const world = createWorld();
	const alice = world.device('alice');
	world.net.runFor(500);
	alice.replica.write('notes/a.md', note('from http\n'));
	world.net.runFor(500);
	const { git } = world;
	// A clone's commit on top of what Git has, written as a transport would before asking.
	const commitOn = async (parent: string | null, text: string) => {
		const tree = new Map((parent === null ? [] : [...(await git.readTree((await git.readCommit(parent))?.tree ?? ''))]) as [string, { mode: string; oid: string }][]);
		tree.set('notes/a.md', { mode: '100644', oid: await git.writeBlob(new TextEncoder().encode(text)) });
		const author = { name: 'alice', email: 'alice@example.com' };
		return git.writeCommit({ tree: await git.writeTree(tree), parents: parent === null ? [] : [parent], message: 'from git\n', author, at: new Date(EPOCH) });
	};
	const push = (old: string | null, next: string) => world.server.receive({ ref: MAIN, old, next }, world.session('alice'));
	const stale = await commitOn(null, note('from git\n'));
	expect(await push(null, stale)).toMatchObject({ kind: 'refused', reason: 'live edits are not in Git yet; a flush is scheduled, fetch and retry' });
	await world.server.idle();
	const flushed = await git.readRef(MAIN);
	expect(await push(null, stale)).toMatchObject({ kind: 'refused', reason: 'main moved; fetch and rebase' });
	const rebased = await commitOn(flushed, note('from git, rebased\n'));
	expect(await push(flushed, rebased)).toMatchObject({ kind: 'accepted', main: rebased, live: { kind: 'applied' } });
	expect(await git.readRef(MAIN)).toBe(rebased);
	expect(world.server.read('notes/a.md')).toBe(note('from git, rebased\n'));
	// Git already holds it: the next flush has nothing to write.
	expect(await world.flush()).toEqual({ kind: 'nothing' });
	world.net.runFor(500);
	expect(alice.replica.read('notes/a.md')).toBe(note('from git, rebased\n'));
});

test('changed: a field removal that lost to an edit leaves the edited field, and nothing is held', () => {
	const { world, alice, bob, settle } = setup();
	const path = 'notes/a.md';
	alice.replica.write(path, note('one\n', 'title: A\nmood: calm'));
	settle();
	alice.setOnline(false);
	alice.replica.edit(path, () => note('one\n'));
	bob.replica.edit(path, () => note('one\n', 'title: A\nmood: busy'));
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read(path)).toBe(note('one\n', 'title: A\nmood: busy'));
	expect(alice.replica.read(path)).toBe(note('one\n', 'title: A\nmood: busy'));
	expect(alice.replica.state(path)).toEqual({ status: 'synced' });
});

test('the door refuses what would break a clone, the same on the device and the server', () => {
	for (const [path, text, reason] of [
		['Notes.MD', '---\n: : bad\n---\n', 'does not parse'],
		['notes/a.md', '---\r\ntitle: X\r\n---\r\nbody\r\n', 'a note must use LF line endings'],
		['notes/a.md', '\uFEFF---\ntitle: X\n---\n', 'a note may not start with a byte order mark'],
		['notes/a.md', writePointer({ oid: 'a'.repeat(64), size: 1 }), 'a note may not be an LFS pointer'],
		['export.json', 'x'.repeat(2_000_000), 'a file may be at most 1 MB'],
		['notes/con.md', '---\n---\n', 'a name may not be a reserved device name'],
		['notes/what?.md', '---\n---\n', 'a name may not hold < > : " \\ | ? * or control characters'],
		['notes/dot.', 'x', 'a name may not end in a space or a period'],
		['a/.GIT/config', 'x', '.git is reserved'],
		['cafe\u0301.md', '---\n---\n', 'the path is not NFC'],
		['.gitattributes', '* -text\n', 'Epicenter owns this file'],
		['sub/.lfsconfig', '[lfs]\n', 'Epicenter owns this file'],
	] as const)
		expect([path, admissible(path, text)]).toEqual([path, reason]);
	const { world, alice } = setup();
	alice.replica.write('notes/con.md', '---\n---\n', { over: null });
	expect(alice.replica.state('notes/con.md')).toEqual({ status: 'held', reason: 'a name may not be a reserved device name' });
	expect(world.server.read('notes/con.md')).toBeNull();
});

test('paths equal after NFC and case folding are one path: concurrent creates of Todo.md and todo.md merge', () => {
	const { world, alice, bob, settle } = setup();
	alice.setOnline(false);
	bob.setOnline(false);
	alice.replica.write('notes/Todo.md', note('alice\n', 'title: Todo'), { over: null });
	bob.replica.write('notes/todo.md', note('bob\n', 'title: Todo'), { over: null });
	alice.setOnline(true);
	settle();
	bob.setOnline(true);
	settle();
	expect([...world.server.snapshot().keys()]).toEqual(['notes/Todo.md']);
	const text = world.server.read('notes/Todo.md') ?? '';
	expect(text).toContain('alice');
	expect(text).toContain('bob');
	expect(bob.replica.read('notes/todo.md')).toBeNull();
	expect(bob.replica.read('notes/Todo.md')).toBe(text);
});

test('a merge that would grow a note past 1 MB is the one named exception: held with that reason', () => {
	const { world, alice, bob, settle } = setup();
	const path = 'notes/big.md';
	const half = 'x'.repeat(600_000);
	alice.replica.write(path, note('start\n'));
	settle();
	bob.setOnline(false);
	alice.replica.edit(path, () => note(`start\n${half}a\n`));
	bob.replica.edit(path, () => note(`start\n${half}b\n`));
	settle();
	bob.setOnline(true);
	settle();
	expect(world.server.read(path)).toBe(note(`start\n${half}a\n`));
	expect(bob.replica.state(path)).toEqual({ status: 'held', reason: 'the merge would grow the note past 1 MB' });
	expect(bob.replica.read(path)).toContain(`${half}b`);
});

test('a flush writes one Git commit at each merge that wrote a block, then one at main, with .gitattributes seeded', async () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write('notes/a.md', note('one\n'));
	settle();
	await world.flush();
	bob.setOnline(false);
	alice.replica.edit('notes/a.md', () => note('two\n'));
	bob.replica.edit('notes/a.md', () => note('three\n'));
	settle();
	bob.setOnline(true);
	settle();
	alice.replica.edit('notes/a.md', (text) => (text ?? '').replace(/<<<<<<<[\s\S]*>>>>>>> [^\n]*\n/, ''));
	settle();
	const flushed = await world.flush();
	if (flushed.kind !== 'flushed') throw new Error(`nothing flushed: ${flushed.kind}`);
	expect(flushed.commits.map((c) => c.message.split('\n')[0])).toEqual(["Merge bob's change into notes/a.md", 'Edit notes/a.md']);
	const head = await world.git.readRef(MAIN);
	expect(head).toBe(flushed.head);
	const tree = await world.git.readTree((await world.git.readCommit(head ?? ''))?.tree ?? '');
	expect([...tree.keys()].sort()).toEqual(['.gitattributes', 'notes/a.md']);
});
