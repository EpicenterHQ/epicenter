/**
 * Scenario Tests
 *
 * The intent of today's engine's held, reconcile, verdict and delete/reuse
 * tests, asserted after phase 0a: live commits with parents,
 * the server merging every writer's commits, the commit id as idempotency, a
 * commit on every save, no stored notices (conflict blocks in the text, and
 * held work with a reason on the device), and a retention window. Each world
 * has a fixed latency and no loss unless a test loses a reply. The people
 * review's probes live in `people.test.ts`.
 *
 * Key behaviors:
 * - A note whose frontmatter does not parse is a note: it syncs, with no fields, and merges by line
 * - A file saved where someone made a folder (or beneath someone's file) is held with why at that file; nothing on main is lost, and a rename sends it
 * - Held text survives a change from elsewhere (rebased) and a restart, and over a remote delete; a repair commits exactly the repaired text
 * - A lost reply is answered by sending the same commit again, which lands once, with its outcome brought up to now; typing since never conflicts with itself
 * - A commit meeting a moved `main` is merged by the server in one push; the device never sends an edit made elsewhere back as its own
 * - Changed (D3): an edit made before a delete, landing after the note was brought back or replaced, is one block in the note there
 * - A rename racing an edit of the old path keeps both, and the renamer's delete stays held
 * - An agent's batch meeting a moved `main` merges as anyone's save does, its files in one commit; the server refuses commits with no parent, a bad id, or a path named twice
 * - Every save commits while online; saves while a commit is in flight, or offline, amend one unsent commit; a sent commit is never rewritten
 * - A commit sent once whose parent left the window merges again after a full catch-up
 * - A held call holds only its own work: an earlier unsent commit below it goes alone, even when the held call has a message and saved the same text there
 */
import { expect, test } from 'bun:test';
import { unwrap } from 'wellcrafted/result';
import { openBunSqlite } from '../bun/sqlite.js';
import { openReplica, type Request, SEND_QUIET } from '../client/replica.js';
import { commitId, type LiveCommit } from '../core/commit.js';
import { findConflicts } from '../core/conflict.js';
import { writePointer } from '../core/markdown.js';
import { BLOCK_CAP } from '../core/settle.js';
import {
	createTestServer,
	createWorld,
	EPOCH,
	QUIET,
	STAMP,
	writer,
} from './harness.js';

const PATH = 'notes/a.md';
const note = (body: string, title = 'A') =>
	`---\ntitle: ${title}\n---\n${body}`;
/** Frontmatter that does not parse: a key given twice. A note all the same, with no fields. */
const broken = (body: string, title = 'A') =>
	`---\ntitle: ${title}\ntitle: B\n---\n${body}`;
/** A note with CRLF line endings, which the door refuses (a folder normalizes them as it reads; a programmatic writer is held). */
const crlf = (body: string, title = 'A') =>
	note(body, title).replaceAll('\n', '\r\n');
const LF = 'a note must use LF line endings';

/** A world whose devices send at once (`quiet: 0`), for exact interleavings; `paused` keeps the send pause. */
function setup(names = ['alice', 'bob'], { paused = false } = {}) {
	const world = createWorld({
		latency: { min: 20, max: 20 },
		...(paused ? {} : { quiet: 0 }),
	});
	const pushes: { device: string; commit: LiveCommit }[] = [];
	world.onRequest((device, request: Request) => {
		if (request.type === 'push')
			pushes.push({ device, commit: request.commit });
	});
	const devices = names.map((name) => world.device(name));
	world.net.runFor(500);
	const [alice, bob, carol] = devices;
	if (alice === undefined || bob === undefined) throw new Error('two devices');
	/** Every text a device ever pushed for a path. */
	const sent = (device: string, path: string) =>
		pushes
			.filter((p) => p.device === device)
			.flatMap((p) =>
				p.commit.files.filter((f) => f.path === path).map((f) => f.text),
			);
	/** Run until everything is quiet, short of the quiet-time flush. */
	const settle = () => world.net.runFor(QUIET - 1_000);
	return { world, alice, bob, carol, pushes, sent, settle };
}

// ============================================================================
// Sending after a pause
// ============================================================================

test('a burst of keystrokes, each saved at once, lands as one text once it has been quiet: others see that one text', () => {
	const { world, alice, bob, sent } = setup(['alice', 'bob'], { paused: true });
	const landed: (string | null)[] = [];
	world.onCommit((committed) => {
		for (const file of committed.files)
			if (file.path === PATH) landed.push(file.after);
	});
	let typed = '';
	for (const key of 'hello') {
		typed += key;
		alice.replica.write(PATH, note(typed));
		expect(alice.replica.read(PATH)).toBe(note(typed));
		world.net.runFor(200);
	}
	expect(sent('alice', PATH)).toEqual([]);
	world.net.runFor(SEND_QUIET);
	expect(sent('alice', PATH)).toEqual([note('hello')]);
	world.net.runFor(500);
	expect(landed).toEqual([note('hello')]);
	expect(bob.replica.read(PATH)).toBe(note('hello'));
});

test('a pause of the window sends, a note whose frontmatter does not parse included: the pause never holds', () => {
	const { world, alice, sent } = setup(['alice', 'bob'], { paused: true });
	alice.replica.write(PATH, '---\ntitle: [\n---\nhalf typed\n');
	world.net.runFor(SEND_QUIET - 100);
	expect(sent('alice', PATH)).toEqual([]);
	expect(alice.replica.state(PATH)).toEqual({ status: 'sending' });
	world.net.runFor(200);
	expect(sent('alice', PATH)).toEqual(['---\ntitle: [\n---\nhalf typed\n']);
	world.net.runFor(500);
	expect(world.server.read(PATH)).toBe('---\ntitle: [\n---\nhalf typed\n');
	expect(alice.replica.state(PATH)).toEqual({ status: 'synced' });
});

// ============================================================================
// Held text (held.test.ts)
// ============================================================================

test('a note whose frontmatter does not parse is a note: it syncs like any text, with no fields', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n'));
	settle();
	alice.replica.write(PATH, broken('one\n'));
	settle();
	expect(alice.replica.state(PATH)).toEqual({ status: 'synced' });
	expect(alice.replica.notSent()).toEqual([]);
	expect(world.server.read(PATH)).toBe(broken('one\n'));
	expect(bob.replica.read(PATH)).toBe(broken('one\n'));
});

test('a note whose frontmatter does not parse merges by line with an edit elsewhere', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n.\n.\nbob\n'));
	settle();
	alice.setOnline(false);
	alice.replica.write(PATH, broken('ONE\n.\n.\nbob\n'));
	bob.replica.edit(PATH, () => note('one\n.\n.\nBOB\n'));
	settle();
	alice.setOnline(true);
	settle();
	for (const text of [
		world.server.read(PATH),
		alice.replica.read(PATH),
		bob.replica.read(PATH),
	])
		expect(text).toBe(broken('ONE\n.\n.\nBOB\n'));
});

test('held text survives a change from elsewhere and a restart, and a repair commits exactly the repaired text', () => {
	const { world, alice, bob, pushes, settle } = setup();
	alice.replica.write(PATH, note('one\n.\n.\nbob\n'));
	settle();
	alice.replica.write(PATH, crlf('ONE\n.\n.\nbob\n'));
	bob.replica.edit(PATH, () => note('one\n.\n.\nBOB\n'));
	settle();
	// Rebased over main's LF text, it is LF now, and still held: it goes only with its person's save.
	expect(alice.replica.read(PATH)).toBe(note('ONE\n.\n.\nBOB\n'));
	alice.restart();
	settle();
	expect(alice.replica.read(PATH)).toBe(note('ONE\n.\n.\nBOB\n'));
	expect(world.server.read(PATH)).toBe(note('one\n.\n.\nBOB\n'));
	expect(alice.replica.state(PATH)).toEqual({ status: 'waiting', reason: LF });
	const before = pushes.length;
	alice.replica.edit(PATH, () => note('ONE\n.\n.\nBOB\n', 'B'));
	settle();
	expect(pushes.slice(before).map((p) => p.commit.files)).toEqual([
		[{ path: PATH, text: note('ONE\n.\n.\nBOB\n', 'B') }],
	]);
	expect(world.server.read(PATH)).toBe(note('ONE\n.\n.\nBOB\n', 'B'));
});

test('held text over a remote delete stays held until its person saves it', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n'));
	settle();
	alice.setOnline(false);
	alice.replica.write(PATH, crlf('one\n'));
	bob.replica.write(PATH, null);
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBeNull();
	expect(alice.replica.notSent()).toEqual([
		{ path: PATH, status: 'waiting', reason: LF },
	]);
	alice.replica.edit(PATH, () => note('one\nkept\n'));
	settle();
	expect(world.server.read(PATH)).toBe(note('one\nkept\n'));
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

test("a resend gets its outcome brought up to now: the device stands on today's main, not the one it landed on", () => {
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
	expect(mine?.files).toEqual([
		{ path: PATH, text: note('one\n.\n.\nb0\n', 'T1') },
	]);
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

test("changed: a rename racing an edit of the old path keeps both; the renamer's delete lost to the edit and is not held", () => {
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
	expect(alice.replica.read(PATH)).toBe(note('one\nbob\n'));
	expect(alice.replica.state(PATH)).toEqual({ status: 'synced' });
	expect(alice.replica.notSent()).toEqual([]);
});

// ============================================================================
// Agents, the server's refusals, cadence, the window
// ============================================================================

test("an agent's batch meeting a moved main merges as anyone's save does; its files, ready together, go in one commit", () => {
	const world = createWorld({ latency: { min: 20, max: 20 }, quiet: 0 });
	const sent: LiveCommit[] = [];
	world.onRequest((device, request) => {
		if (device === 'agent' && request.type === 'push')
			sent.push(request.commit);
	});
	const alice = world.device('alice');
	const agent = world.device('agent');
	world.net.runFor(500);
	alice.replica.write(PATH, note('one\n'));
	world.net.runFor(500);
	alice.replica.edit(PATH, () => note('one\nalice\n'));
	world.net.runFor(5);
	agent.replica.writeAll({
		[PATH]: note('agent\none\n'),
		'notes/b.md': note('two\n'),
	});
	world.net.runFor(2_000);
	expect(world.server.read(PATH)).toBe(note('agent\none\nalice\n'));
	expect(world.server.read('notes/b.md')).toBe(note('two\n'));
	expect(agent.replica.lastRefusal()).toBeNull();
	expect([
		...new Set(sent.map((commit) => commit.files.map((f) => f.path).join(' '))),
	]).toEqual([`${PATH} notes/b.md`]);
});

test('the server refuses a commit with no parent, a bad id, or a path named twice, and a resend gets the recorded outcome', () => {
	const server = createTestServer();
	const session = writer('x');
	const make = (files: LiveCommit['files']): LiveCommit => {
		const body = {
			parent: server.main(),
			author: { user: 'x', device: 'x' },
			time: STAMP,
			files,
		};
		return { id: commitId(body), ...body };
	};
	const first = make([{ path: PATH, text: note('one\n') }]);
	expect(server.push(first, session)).toMatchObject({
		kind: 'applied',
		main: first.id,
	});
	expect(server.push(first, session)).toMatchObject({
		kind: 'applied',
		main: first.id,
	});
	expect(server.history().commits).toBe(1);
	expect(
		server.push(
			{ ...make([]), parent: undefined } as unknown as LiveCommit,
			session,
		),
	).toMatchObject({ kind: 'rejected', code: 'no-parent', reason: 'no parent' });
	expect(
		server.push(
			{ ...make([{ path: PATH, text: 'x' }]), id: 'forged' },
			session,
		),
	).toMatchObject({
		kind: 'rejected',
		code: 'bad-id',
		reason: 'the id is not the hash of the commit',
	});
	expect(
		server.push(
			make([
				{ path: 'notes/b.md', text: '---\n---\nb\n' },
				{ path: 'notes/B.md', text: '---\n---\nc\n' },
			]),
			session,
		),
	).toMatchObject({
		kind: 'rejected',
		code: 'path-twice',
	});
	expect(
		server.push(make([{ path: PATH, text: crlf('one\n') }]), session),
	).toMatchObject({
		kind: 'refused',
		code: 'inadmissible',
		reason: LF,
		path: PATH,
	});
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
	expect(pushes.slice(10).map((p) => p.commit.files[0]?.text)).toEqual([
		note('a\n'),
		note('abc\n'),
	]);
	alice.setOnline(false);
	for (let i = 0; i < 20; i++)
		alice.replica.write(PATH, note(`offline ${i}\n`));
	alice.setOnline(true);
	settle();
	expect(pushes.slice(12).map((p) => p.commit.files[0]?.text)).toEqual([
		note('offline 19\n'),
	]);
	expect(world.server.read(PATH)).toBe(note('offline 19\n'));
});

test('a commit sent once whose parent left the retention window merges again after a full catch-up, and lands once', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n.\n.\nend\n'));
	settle();
	alice.setOnline(false);
	alice.replica.edit(PATH, () => note('ONE\n.\n.\nend\n'));
	for (let round = 0; round < 3; round++) {
		bob.replica.edit(PATH, (text) =>
			(text ?? '').replace('end', `end ${round}`),
		);
		world.net.runFor(QUIET * 5);
	}
	alice.setOnline(true);
	settle();
	expect(world.server.read(PATH)).toBe(note('ONE\n.\n.\nend 2 1 0\n'));
	expect(alice.replica.read(PATH)).toBe(world.server.read(PATH));
	expect(alice.replica.position()).toBe(world.server.main());
	expect(alice.replica.stats().unknown).toBe(1);
});

test('a stale-parent flood writes each different text once, an identical one not again, and is refused past the block cap', () => {
	const server = createTestServer();
	let clock = 0;
	// Each commit is new (its own time, so its own id): a resend of one would just get its recorded outcome.
	const make = (
		parent: string,
		files: LiveCommit['files'],
		user = 'x',
	): LiveCommit => {
		const body = {
			parent,
			author: { user, device: user },
			time: new Date(EPOCH + clock++).toISOString(),
			files,
		};
		return { id: commitId(body), ...body };
	};
	const root = server.main();
	expect(
		server.push(make(root, [{ path: PATH, text: note('one\n') }]), writer('x')),
	).toMatchObject({ kind: 'applied' });
	// Every flood commit stands on the parent before the note existed: each is another note at the path (D3).
	const same = note('flood\n', 'flood');
	for (let i = 0; i < 3; i++)
		expect(
			server.push(make(root, [{ path: PATH, text: same }], 'm'), writer('m')),
		).toMatchObject({ kind: 'merged' });
	expect(findConflicts(server.read(PATH) ?? '')).toHaveLength(1);
	for (let i = 1; i < BLOCK_CAP; i++)
		expect(
			server.push(
				make(root, [{ path: PATH, text: note(`flood ${i}\n`, 'flood') }], 'm'),
				writer('m'),
			),
		).toMatchObject({ kind: 'merged' });
	expect(findConflicts(server.read(PATH) ?? '')).toHaveLength(BLOCK_CAP);
	expect(
		server.push(
			make(root, [{ path: PATH, text: note('one more\n', 'flood') }], 'm'),
			writer('m'),
		),
	).toMatchObject({
		kind: 'refused',
		code: 'too-many-blocks',
		reason: 'this note has unresolved conflicts; resolve some first',
		path: PATH,
	});
	expect(findConflicts(server.read(PATH) ?? '')).toHaveLength(BLOCK_CAP);
});

test("a person's merge past the block cap, caused by other people's blocks, is held with the reason on their device", () => {
	const { world, alice, bob, settle } = setup();
	const blocks = Array.from(
		{ length: BLOCK_CAP },
		(_, i) => `<<<<<<< main\n||||||| base\n=======\nold ${i}\n>>>>>>> m/m\n`,
	).join('');
	alice.replica.write(PATH, note(`one\n.\n.\n${blocks}`));
	settle();
	alice.setOnline(false);
	alice.replica.edit(PATH, (text) => (text ?? '').replace('one\n', 'ONE\n'));
	bob.replica.edit(PATH, (text) => (text ?? '').replace('one\n', 'uno\n'));
	settle();
	alice.setOnline(true);
	settle();
	expect(alice.replica.state(PATH)).toEqual({
		status: 'waiting',
		reason: 'this note has unresolved conflicts; resolve some first',
	});
	// Her text is kept, and goes once she resolves blocks and saves.
	expect(alice.replica.read(PATH)).toContain('ONE\n');
	expect(findConflicts(world.server.read(PATH) ?? '')).toHaveLength(BLOCK_CAP);
	expect(world.server.read(PATH)).toContain('uno\n');
});

test('a file saved offline where someone made a folder is held with why; the folder keeps its files, and a rename sends the file', () => {
	const { world, alice, bob, settle } = setup();
	const cover = { oid: 'c'.repeat(64), size: 5 };
	world.server.upload(cover.oid, cover.size);
	alice.setOnline(false);
	alice.replica.write('album', writePointer(cover));
	alice.replica.present(cover.oid, cover.size);
	bob.replica.write('album/a.md', note('a\n'));
	settle();
	alice.setOnline(true);
	settle();
	expect(alice.replica.state('album')).toEqual({
		status: 'refused',
		reason: 'a folder already has this name',
	});
	expect(world.server.read('album/a.md')).toBe(note('a\n'));
	expect(world.server.read('album')).toBeNull();
	expect(alice.replica.read('album/a.md')).toBe(note('a\n'));
	expect(bob.replica.read('album/a.md')).toBe(note('a\n'));
	// She renames her file: it goes, and nothing stays held.
	alice.replica.writeAll({ album: null, 'album.png': writePointer(cover) });
	settle();
	expect(alice.replica.notSent()).toEqual([]);
	expect(world.server.read('album.png')).toBe(writePointer(cover));
	expect(world.server.read('album/a.md')).toBe(note('a\n'));
});

test('a refusal arriving after its path was saved again holds nothing: the newer save goes (seed 1475)', () => {
	const { world, alice, bob, settle } = setup();
	const blocks = Array.from(
		{ length: BLOCK_CAP },
		(_, i) => `<<<<<<< main\n||||||| base\n=======\nold ${i}\n>>>>>>> m/m\n`,
	).join('');
	alice.replica.write(PATH, note(`one\n.\n.\n${blocks}`));
	settle();
	// Bob's edit lands at +20 and its notification reaches alice at +40; alice's edit, sent at +21, meets it on the server and is refused past the cap.
	bob.replica.edit(PATH, (text) => (text ?? '').replace('one\n', 'uno\n'));
	world.net.runFor(21);
	alice.replica.edit(PATH, (text) => (text ?? '').replace('one\n', 'ONE\n'));
	world.net.runFor(24);
	// Before the refusal arrives, alice renames the note: the delete and the new path are her newest save.
	alice.replica.writeAll({
		[PATH]: null,
		'notes/b.md': alice.replica.read(PATH),
	});
	while (alice.replica.stats().refused === 0) world.net.runFor(1);
	// The refused text was replaced: nothing is held, and the rename goes as it is.
	expect(alice.replica.notSent()).toEqual([]);
	expect(alice.replica.state('notes/b.md')).toEqual({ status: 'sending' });
	settle();
	expect(alice.replica.notSent()).toEqual([]);
	expect(alice.replica.busy()).toBe(false);
	expect(alice.replica.position()).toBe(world.server.main());
	expect(world.server.read('notes/b.md')).toContain('ONE\n');
	// Her delete lost to bob's edit, which she had not seen: his note stays.
	expect(world.server.read(PATH)).toContain('uno\n');
});

test('a blob write that lost lands beside its file: the note saved with it goes, and the device keeps taking in changes from elsewhere (seed 1475)', () => {
	const { world, alice, bob, settle } = setup();
	const pointer = (c: string) => writePointer({ oid: c.repeat(64), size: 3 });
	for (const c of ['a', 'b', 'c']) {
		world.server.upload(c.repeat(64), 3);
		for (const device of [alice, bob]) device.replica.present(c.repeat(64), 3);
	}
	alice.replica.write('img/z.png', pointer('a'));
	settle();
	// While a commit is in flight, a note and new bytes at a blob path are committed together; other bytes land at that path first, so hers land beside them, and the note goes too.
	alice.replica.write('notes/x.md', note('x\n'));
	alice.replica.writeAll({ [PATH]: note('one\n'), 'img/z.png': pointer('b') });
	bob.replica.write('img/z.png', pointer('c'));
	settle();
	expect(world.server.read('img/z.png')).toBe(pointer('c'));
	expect(world.server.read(`img/z (conflict ${'b'.repeat(7)}).png`)).toBe(
		pointer('b'),
	);
	expect(alice.replica.state('img/z.png')).toEqual({ status: 'synced' });
	expect(alice.replica.state(PATH)).toEqual({ status: 'synced' });
	expect(world.server.read(PATH)).toBe(note('one\n'));
	bob.replica.write('notes/c.md', note('bob\n'));
	settle();
	expect(alice.replica.read('notes/c.md')).toBe(note('bob\n'));
	expect(alice.replica.position()).toBe(world.server.main());
});

test('a later save the door refuses holds only that file: the unsent commit below it goes, and so does what was saved with it', () => {
	const { world, alice, settle } = setup();
	// While a commit is in flight, two paths saved together are committed; then one of them is saved again with CRLF endings.
	alice.replica.write('notes/x.md', note('x\n'));
	alice.replica.writeAll({
		[PATH]: note('one\n'),
		'notes/b.md': note('two\n'),
	});
	alice.replica.write(PATH, crlf('one\n'));
	settle();
	expect(world.server.read(PATH)).toBe(note('one\n'));
	expect(world.server.read('notes/b.md')).toBe(note('two\n'));
	expect(alice.replica.notSent()).toEqual([
		{ path: PATH, status: 'waiting', reason: LF },
	]);
	expect(alice.replica.state('notes/b.md')).toEqual({ status: 'synced' });
});

test('a rename whose new file is held: the delete goes alone, an older re-creation of the path never does, and the repaired file lands (seed 2315)', () => {
	const { world, alice, settle } = setup();
	alice.replica.write(PATH, note('one\n'));
	settle();
	// The delete goes; while it is in flight the note is created again (an unsent commit), then renamed to a name the repository cannot take.
	alice.replica.write(PATH, null);
	alice.replica.write(PATH, note('two\n'));
	alice.replica.writeAll({ [PATH]: null, 'notes/b?.md': note('two\n') });
	settle();
	expect(alice.replica.notSent()).toEqual([
		{
			path: 'notes/b?.md',
			status: 'refused',
			reason: 'a name may not hold < > : " \\ | ? * or control characters',
		},
	]);
	// The person renames the held file again: it goes, and the older re-creation never does.
	alice.replica.writeAll({ 'notes/b?.md': null, 'notes/b.md': note('two\n') });
	settle();
	expect(world.server.read('notes/b.md')).toBe(note('two\n'));
	expect(world.server.read(PATH)).toBeNull();
	expect(alice.replica.read(PATH)).toBeNull();
	expect(alice.replica.busy()).toBe(false);
});

test('a device that restarts or loses its storage never hears replies meant for the replica it replaced (seed 15595)', () => {
	const { world, alice, settle } = setup();
	for (const replace of [() => alice.restart(), () => alice.lose()]) {
		// A push in flight when the replica is replaced: its reply belongs to the old replica, whose request ids the new one may reuse.
		alice.replica.write(PATH, note(`${world.net.now()}\n`));
		replace();
		settle();
		expect(alice.replica.stats().late).toBe(0);
	}
});

test('a notification arriving while a catch-up is out waits for it: the catch-up never moves the position back (seed 18504)', () => {
	const requests: Request[] = [];
	const replica = unwrap(
		openReplica({
			driver: openBunSqlite(),
			binding: { repository: 'test', server: 'memory', account: 'alice' },
			device: 'alice',
			after: () => {},
			now: () => 0,
			quiet: 0,
		}),
	);
	replica.attach((request) => requests.push(request));
	const caughtUp = (rid: number, main: string, full: boolean) =>
		replica.reply({
			type: 'caught-up',
			rid,
			catchUp: { main, full, files: [], commits: [], next: null },
		});
	caughtUp(1, 'A', true);
	// A connection opens naming a main other than A: a catch-up from A goes out, answered (as over HTTP, apart from events) while main was still A.
	replica.hello({
		repository: 'test',
		server: 'memory',
		user: 'alice',
		main: 'B',
	});
	expect(requests.at(-1)).toMatchObject({ type: 'catch-up', from: 'A' });
	// B lands next, and its notification (a delete: nothing to read) overtakes the catch-up's reply.
	replica.notify({
		commit: 'B',
		parents: ['A'],
		files: [{ path: PATH, hash: null }],
	});
	caughtUp(requests.at(-1)?.rid ?? 0, 'A', false);
	replica.notify({
		commit: 'C',
		parents: ['B'],
		files: [{ path: PATH, hash: null }],
	});
	expect(replica.position()).toBe('C');
});

// ============================================================================
// Per-file outcomes
// ============================================================================

test('each file this device sent says how it landed: landed, with conflict blocks, at a sibling, or a delete that did not take', () => {
	const { world, alice, bob, settle } = setup();
	const pointer = (c: string) => writePointer({ oid: c.repeat(64), size: 3 });
	for (const c of ['a', 'b']) {
		world.server.upload(c.repeat(64), 3);
		for (const device of [alice, bob]) device.replica.present(c.repeat(64), 3);
	}
	alice.replica.writeAll({
		'notes/x.md': note('one\n'),
		'notes/y.md': note('y\n'),
	});
	settle();
	expect(alice.replica.outcomes()).toEqual([
		{ path: 'notes/x.md', outcome: { kind: 'landed' } },
		{ path: 'notes/y.md', outcome: { kind: 'landed' } },
	]);
	alice.setOnline(false);
	alice.replica.writeAll({
		'notes/x.md': note('mine\n'),
		'notes/y.md': null,
		'img/z.png': pointer('a'),
	});
	bob.replica.writeAll({
		'notes/x.md': note('theirs\n'),
		'notes/y.md': note('y\nkept\n'),
		'img/z.png': pointer('b'),
	});
	settle();
	alice.setOnline(true);
	settle();
	expect(alice.replica.outcomes()).toEqual([
		{
			path: 'img/z.png',
			outcome: { kind: 'sibling', at: `img/z (conflict ${'a'.repeat(7)}).png` },
		},
		{ path: 'notes/x.md', outcome: { kind: 'blocks' } },
		{ path: 'notes/y.md', outcome: { kind: 'delete-did-not-take' } },
	]);
	// A new save of a path forgets how its last one landed.
	alice.replica.write('notes/x.md', null);
	expect(alice.replica.outcomes().map((o) => o.path)).toEqual([
		'img/z.png',
		'notes/y.md',
	]);
});

test('what is not sent waits (the system clears it) or is refused (only a person can fix it)', () => {
	const { alice, settle } = setup();
	alice.replica.write('notes/con.md', note('x\n'));
	alice.replica.write(
		'img/new.png',
		writePointer({ oid: 'e'.repeat(64), size: 3 }),
	);
	alice.replica.write(PATH, crlf('x\n'));
	alice.replica.writeAll(
		{},
		{
			refused: {
				'notes/Twin.md': 'another file has this name in different letters',
			},
		},
	);
	settle();
	expect(alice.replica.state('notes/con.md')).toEqual({
		status: 'refused',
		reason: 'a name may not be a reserved device name',
	});
	expect(alice.replica.state('notes/Twin.md')).toEqual({
		status: 'refused',
		reason: 'another file has this name in different letters',
	});
	expect(alice.replica.state('img/new.png')).toEqual({
		status: 'waiting',
		reason: 'its bytes are uploading',
	});
	expect(alice.replica.state(PATH)).toEqual({ status: 'waiting', reason: LF });
	expect(alice.replica.notSent()).toEqual([
		{
			path: 'img/new.png',
			status: 'waiting',
			reason: 'its bytes are uploading',
		},
		{
			path: 'notes/Twin.md',
			status: 'refused',
			reason: 'another file has this name in different letters',
		},
		{ path: 'notes/a.md', status: 'waiting', reason: LF },
		{
			path: 'notes/con.md',
			status: 'refused',
			reason: 'a name may not be a reserved device name',
		},
	]);
});
