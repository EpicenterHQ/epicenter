/**
 * Each Write Carries Its Base
 *
 * A write is one file saying what it saw: its base, the Git blob hash of the
 * version its device last saw there. A device's pushes are numbered (an
 * epoch and a seq), so the server answers a resend exactly and tells a
 * database restored from a copy that it is behind itself.
 *
 * Key behaviors:
 * - A device away for a week merges against its base, held live or read from Git
 * - A lost answer resolves exactly: the resend gets the answer, nothing lands twice
 * - A restored database neither applies an old change twice nor loses unsent work
 * - A note deleted and created again since a base merges by its content (the accepted oddity)
 * - Notes and blobs go together in one push, each its own kind
 */
import { expect, test } from 'bun:test';
import { findConflicts } from '../core/conflict.js';
import { writePointer } from '../core/markdown.js';
import { createWorld, QUIET } from './harness.js';

const note = (body: string) => `---\ntitle: N\n---\n${body}`;
const PATH = 'notes/n.md';
const WEEK = 7 * 24 * 60 * 60_000;

function setup() {
	const world = createWorld({ latency: { min: 20, max: 20 }, quiet: 0 });
	const alice = world.device('alice');
	const bob = world.device('bob');
	world.net.runFor(500);
	const settle = () => world.net.runFor(QUIET - 1_000);
	/** Settle, letting reads from Git (promises) finish between rounds. */
	const settleAll = async () => {
		for (let round = 0; round < 5; round++) {
			settle();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	};
	return { world, alice, bob, settle, settleAll };
}

/** Alice's edit goes out, and the push is lost on the way: she is offline before it arrives. */
function sendAndLose(
	alice: ReturnType<typeof setup>['alice'],
	text: string,
): void {
	alice.replica.write(PATH, text);
	expect(alice.replica.sent()?.files.map((f) => f.path)).toEqual([PATH]);
	alice.setOnline(false);
}

test('a device away for a week merges against its base, a version Git never had, kept live', async () => {
	const { world, alice, bob, settle, settleAll } = setup();
	bob.replica.write(PATH, note('one\n'));
	settle();
	// Alice's base is "one", which Git never gets: bob replaces it before any flush.
	sendAndLose(alice, note('one\nalice\n'));
	bob.replica.write(PATH, note('zero\none\n'));
	settle();
	await world.flush();
	world.net.runFor(WEEK);
	bob.replica.edit('notes/other.md', () => note('later\n'));
	settle();
	await world.flush();
	alice.setOnline(true);
	await settleAll();
	const text = world.server.read(PATH) ?? '';
	expect(text).toBe(note('zero\none\nalice\n'));
	expect(alice.replica.read(PATH)).toBe(text);
	expect(alice.replica.unsent()).toEqual([]);
});

test('a device away for a week merges against its base read from Git, once the store let it go', async () => {
	const { world, alice, bob, settle, settleAll } = setup();
	bob.replica.write(PATH, note('one\n'));
	settle();
	await world.flush();
	sendAndLose(alice, note('one\nalice\n'));
	bob.replica.write(PATH, note('zero\none\n'));
	settle();
	// A week on, two flushes later, the store keeps "one" no longer: only Git has it.
	world.net.runFor(WEEK);
	await world.flush();
	bob.replica.edit('notes/other.md', () => note('later\n'));
	settle();
	world.net.runFor(WEEK);
	await world.flush();
	expect(
		world.server.history().bytes < 2 * note('zero\none\n').length + 200,
	).toBe(true);
	alice.setOnline(true);
	await settleAll();
	const text = world.server.read(PATH) ?? '';
	expect(text).toBe(note('zero\none\nalice\n'));
	expect(findConflicts(text)).toEqual([]);
	expect(alice.replica.read(PATH)).toBe(text);
	// The server read the base from Git (answering "reading" meanwhile), never took it as unknown.
	expect(alice.replica.stats().refused).toBeGreaterThan(0);
});

test('a lost answer resolves exactly: the resend gets the same answer, and nothing lands twice', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\n'));
	settle();
	const before = world.server.history().commits;
	alice.loseNextReply();
	alice.replica.write(PATH, note('one\nalice\n'));
	settle();
	expect(world.server.history().commits).toBe(before + 1);
	const text = world.server.read(PATH) ?? '';
	expect(text).toBe(note('one\nalice\n'));
	for (const d of [alice, bob]) expect(d.replica.read(PATH)).toBe(text);
	expect(alice.replica.unsent()).toEqual([]);
	expect(alice.replica.stats().timeouts).toBeGreaterThan(0);
	expect(alice.replica.stats().behind).toBe(0);
});

test('a restored database neither applies an old change twice nor loses unsent work: notes, blobs and deletes', () => {
	const { world, alice, bob, settle } = setup();
	const blob = { oid: 'b'.repeat(64), size: 3 };
	const other = { oid: 'c'.repeat(64), size: 4 };
	for (const p of [blob, other]) {
		world.upload(p.oid, p.size);
		for (const d of [alice, bob]) d.replica.present(p.oid, p.size);
	}
	alice.replica.writeAll({
		[PATH]: note('one\n'),
		'notes/gone.md': note('gone\n'),
		'notes/kept.md': note('kept\n'),
		'audio/a.webm': writePointer(blob),
	});
	settle();
	// Offline, alice saves work, and her database is copied with it unsent.
	alice.setOnline(false);
	alice.replica.writeAll({
		[PATH]: note('one\nlanded\n'),
		'notes/gone.md': null,
		'audio/a.webm': writePointer(other),
		'notes/kept.md': note('kept\nnever sent\n'),
	});
	const copy = alice.snapshot();
	// That work lands (but the kept note's, which she takes back), and more after it.
	alice.replica.write('notes/kept.md', note('kept\n'));
	alice.setOnline(true);
	settle();
	alice.replica.write(PATH, note('one\nlanded\nlater\n'));
	settle();
	expect(world.server.read(PATH)).toBe(note('one\nlanded\nlater\n'));
	// The copy comes back: its pushes are behind the ones the server took.
	alice.restore(copy);
	settle();
	settle();
	expect(alice.replica.stats().behind).toBe(1);
	// Nothing landed twice: a note's work already there is not repeated, a blob already there is one file, a delete that landed stays.
	const text = world.server.read(PATH) ?? '';
	expect(text.split('\n').filter((line) => line === 'landed')).toHaveLength(1);
	expect(text.split('\n').filter((line) => line === 'later')).toHaveLength(1);
	expect(world.server.read('audio/a.webm')).toBe(writePointer(other));
	expect(world.server.read('notes/gone.md')).toBeNull();
	expect(
		[...world.server.snapshot().keys()].filter((p) => p.includes('conflict')),
	).toEqual([]);
	// Unsent work is not lost: the kept note's line, which never landed, is there.
	expect(world.server.read('notes/kept.md')).toContain('never sent');
	for (const d of [alice, bob])
		for (const path of [PATH, 'notes/kept.md', 'audio/a.webm'])
			expect(d.replica.read(path)).toBe(world.server.read(path));
	expect(alice.replica.unsent()).toEqual([]);
});

test('a restored database whose unsent work lost to a newer write keeps both: a note as one block, a blob beside it, a delete that does not take', () => {
	const { world, alice, bob, settle } = setup();
	const [x, y, z] = ['1', '2', '3'].map((c, i) => ({
		oid: c.repeat(64),
		size: 10 + i,
	})) as [
		{ oid: string; size: number },
		{ oid: string; size: number },
		{ oid: string; size: number },
	];
	for (const p of [x, y, z]) {
		world.upload(p.oid, p.size);
		for (const d of [alice, bob]) d.replica.present(p.oid, p.size);
	}
	alice.replica.writeAll({
		[PATH]: note('one\n'),
		'audio/a.webm': writePointer(x),
		'notes/gone.md': note('gone\n'),
	});
	settle();
	// A push of alice's lands, so the server's seq for her is ahead of any copy made before it.
	alice.replica.write('notes/seq.md', note('seq\n'));
	settle();
	const copy = (() => {
		alice.setOnline(false);
		alice.replica.writeAll({
			[PATH]: note('one\nmine\n'),
			'audio/a.webm': writePointer(y),
			'notes/gone.md': null,
		});
		return alice.snapshot();
	})();
	// The live database takes that work back and sends something else; bob writes over all three.
	alice.replica.writeAll({
		[PATH]: note('one\n'),
		'audio/a.webm': writePointer(x),
		'notes/gone.md': note('gone\n'),
		'notes/after.md': note('after\n'),
	});
	alice.setOnline(true);
	settle();
	bob.replica.writeAll({
		[PATH]: note('bob\n'),
		'audio/a.webm': writePointer(z),
		'notes/gone.md': note('gone\nbob\n'),
	});
	settle();
	alice.restore(copy);
	settle();
	settle();
	expect(alice.replica.stats().behind).toBe(1);
	const text = world.server.read(PATH) ?? '';
	expect(text.startsWith(note('bob\n'))).toBe(true);
	expect(findConflicts(text)).toHaveLength(1);
	expect(text).toContain('mine');
	expect(world.server.read('audio/a.webm')).toBe(writePointer(z));
	expect(
		world.server.read(`audio/a (conflict ${y.oid.slice(0, 7)}).webm`),
	).toBe(writePointer(y));
	expect(world.server.read('notes/gone.md')).toBe(note('gone\nbob\n'));
	for (const path of [PATH, 'audio/a.webm', 'notes/gone.md'])
		expect(alice.replica.read(path)).toBe(world.server.read(path));
});

test('a note deleted and created again since a base merges by its content: the accepted, visible oddity', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(PATH, note('one\ntwo\n'));
	settle();
	alice.setOnline(false);
	alice.replica.write(PATH, note('ONE\ntwo\n'));
	bob.replica.write(PATH, null);
	settle();
	bob.replica.write(PATH, note('one\ntwo\nthree\n'), { over: null });
	settle();
	alice.setOnline(true);
	settle();
	// Nothing tells the new note from the old one: alice's edit merges into it as an edit of what she saw.
	expect(world.server.read(PATH)).toBe(note('ONE\ntwo\nthree\n'));
});

test('notes and blobs go in one push, each as its own kind: a note as text, a blob as its bytes, never a pointer', () => {
	const { world, alice, settle } = setup();
	const bytes = { oid: 'd'.repeat(64), size: 5 };
	world.upload(bytes.oid, bytes.size);
	alice.replica.present(bytes.oid, bytes.size);
	const pushes: unknown[] = [];
	world.onRequest((_, request) => {
		if (request.type === 'push') pushes.push(request.push.files);
	});
	alice.replica.writeAll({
		[PATH]: note('one\n'),
		'audio/a.webm': writePointer(bytes),
		'notes/old.md': null,
	});
	settle();
	expect(pushes).toEqual([
		[
			{ path: PATH, base: null, next: { text: note('one\n') } },
			{ path: 'audio/a.webm', base: null, next: { blob: bytes } },
		],
	]);
	expect(world.server.read(PATH)).toBe(note('one\n'));
	expect(world.server.read('audio/a.webm')).toBe(writePointer(bytes));
});
