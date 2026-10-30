/**
 * Replica Blob Tests
 *
 * The replica's gate on blobs, in the memory world: a pointer whose bytes
 * the server does not hold yet is owed, and an owed pointer stays saved on
 * this device and out of every commit until the upload track marks its
 * bytes present. Owed is derived, never stored: a file whose text is a
 * pointer this device made, whose oid is neither present nor refused.
 *
 * Each file goes on its own: an owed pointer waits alone for its bytes, and
 * a refused upload or a blob write that lost holds only that pointer. A
 * note saved with it never waits for it.
 *
 * Key behaviors:
 * - An owed pointer waits alone for its bytes: the note saved with it goes at once, the pointer once its bytes are present
 * - Two notes and a new blob saved at once, with a delayed upload across typing elsewhere: the notes land, merged with the typing, and the blob once uploaded
 * - A refused upload holds only its pointer, with why; a blob write that lost on the server lands beside its file, at a sibling
 * - A person's separate attach never blocks a note
 * - A pointer deleted before its upload sends nothing, and its bytes are no longer owed
 * - Two devices with the same bytes at one path: one upload, one file
 * - A refused upload holds every pointer naming those bytes, with the reason; a save of the path clears it, and saving the same bytes again owes them again
 * - Owed pointers survive a reopen, and count as busy and unsent
 * - A blob write over a blob that moved while its bytes were uploading is uploaded still, and lands beside it
 * - A pointer saved over an owed pointer while a commit is out: the notes go, neither pointer before its bytes, and the newer once present
 * - `main`'s own pointer saved while a change to its path is in flight is not `main`'s once that change lands, so it never goes before its bytes, even under a later save
 * - A blob replace made over bytes deleted and attached again since lands: compare-and-swap is on the bytes
 * - A note saved with a blob that lost goes on its own; the blob lands beside, and new bytes go only once present
 */
import { expect, test } from 'bun:test';
import type { LiveCommit } from '../core/commit.js';
import { writePointer } from '../core/markdown.js';
import { createWorld } from '../sim/harness.js';
import type { FileStatus } from './replica.js';

const note = (body: string, fields = 'title: R1') => `---\n${fields}\n---\n${body}`;
const AUDIO = 'recordings/r1.webm';
const NOTE = 'recordings/r1.md';
/** Where a write of `bytes` at AUDIO that lost lands. */
const beside = (bytes: { oid: string }) => `recordings/r1 (conflict ${bytes.oid.slice(0, 7)}).webm`;
const a = { oid: 'a'.repeat(64), size: 3_145_728 };
const b = { oid: 'b'.repeat(64), size: 1_000 };
const UPLOADING: FileStatus = { status: 'waiting', reason: 'its bytes are uploading' };

function setup(names = ['alice', 'bob']) {
	const world = createWorld({ latency: { min: 20, max: 20 }, quiet: 0 });
	/** Every commit the server was sent, by device. */
	const pushed: { device: string; commit: LiveCommit }[] = [];
	world.onRequest((device, request) => {
		if (request.type === 'push') pushed.push({ device, commit: request.commit });
	});
	const devices = names.map((name) => world.device(name));
	world.net.runFor(500);
	const [alice, bob] = devices;
	if (alice === undefined || bob === undefined) throw new Error('two devices');
	const settle = () => world.net.runFor(10_000);
	/** Whether any commit sent so far named `path`. */
	const sent = (path: string) => pushed.some(({ commit }) => commit.files.some((file) => file.path === path));
	return { world, alice, bob, settle, sent, pushed };
}

test('an owed pointer waits alone for its bytes: the note saved with it goes at once, the pointer once its bytes are present', () => {
	const { world, alice, settle, sent, pushed } = setup();
	alice.setOnline(false);
	alice.replica.writeAll({ [NOTE]: note('', `title: R1\naudio: ${AUDIO}`), [AUDIO]: writePointer(a) });
	expect(alice.replica.state(AUDIO)).toEqual(UPLOADING);
	expect(alice.replica.state(NOTE)).toEqual({ status: 'sending' });
	expect(alice.replica.owed()).toEqual([a]);
	alice.setOnline(true);
	settle();
	expect(sent(AUDIO)).toBe(false);
	expect(world.server.read(NOTE)).not.toBeNull();
	expect(alice.replica.state(NOTE)).toEqual({ status: 'synced' });
	expect(alice.replica.busy()).toBe(true);
	// The upload track: the bytes reach the server, then this device marks them present.
	world.upload(a.oid, a.size);
	alice.replica.present(a.oid, a.size);
	expect(alice.replica.owed()).toEqual([]);
	settle();
	expect(world.server.read(AUDIO)).toBe(writePointer(a));
	expect(pushed.map(({ commit }) => commit.files.map((f) => f.path))).toEqual([[NOTE], [AUDIO]]);
	for (const path of [NOTE, AUDIO]) expect(alice.replica.state(path)).toEqual({ status: 'synced' });
});

test('two notes and a new blob saved at once, with a delayed upload across typing elsewhere: the notes land, merged with the typing, and the blob once uploaded', () => {
	const { world, alice, bob, settle } = setup();
	bob.replica.writeAll({ 'notes/one.md': note('one\n'), 'notes/two.md': note('two\n') });
	settle();
	alice.replica.writeAll({ 'notes/one.md': note('one\nagent\n'), 'notes/two.md': note('agent\ntwo\n'), [AUDIO]: writePointer(a) });
	// Typing elsewhere while the bytes upload.
	for (const word of ['x', 'y', 'z']) {
		bob.replica.edit('notes/one.md', (text) => `${text}${word}\n`);
		settle();
	}
	expect(world.server.read('notes/two.md')).toBe(note('agent\ntwo\n'));
	expect(world.server.read(AUDIO)).toBeNull();
	world.upload(a.oid, a.size);
	alice.replica.present(a.oid, a.size);
	settle();
	for (const word of ['agent', 'x', 'y', 'z']) expect(world.server.read('notes/one.md')).toContain(`${word}\n`);
	expect(world.server.read(AUDIO)).toBe(writePointer(a));
});

test('a refused upload holds only its pointer, with why; the note saved with it goes', () => {
	const { world, alice, settle, sent } = setup();
	alice.replica.writeAll({ [NOTE]: note('', `title: R1\naudio: ${AUDIO}`), [AUDIO]: writePointer(a) });
	alice.replica.refused(a.oid, 'over the quota');
	settle();
	expect(alice.replica.state(AUDIO)).toEqual({ status: 'waiting', reason: 'over the quota' });
	expect(alice.replica.state(NOTE)).toEqual({ status: 'synced' });
	expect(world.server.read(NOTE)).not.toBeNull();
	expect(sent(AUDIO)).toBe(false);
	// Its person drops the recording.
	alice.replica.write(AUDIO, null);
	settle();
	expect(alice.replica.notSent()).toEqual([]);
	expect(world.server.read(AUDIO)).toBeNull();
	expect(alice.replica.busy()).toBe(false);
});

test('a blob write that lost on the server lands beside its file; the note saved with it lands', () => {
	const { world, alice, bob, settle } = setup();
	world.upload(a.oid, a.size);
	world.upload(b.oid, b.size);
	for (const device of [alice, bob]) device.replica.present(b.oid, b.size);
	alice.replica.present(a.oid, a.size);
	alice.setOnline(false);
	alice.replica.writeAll({ [NOTE]: note('', `title: R1\naudio: ${AUDIO}`), [AUDIO]: writePointer(a) });
	bob.replica.write(AUDIO, writePointer(b));
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read(AUDIO)).toBe(writePointer(b));
	expect(world.server.read(beside(a))).toBe(writePointer(a));
	expect(alice.replica.read(beside(a))).toBe(writePointer(a));
	expect(alice.replica.state(AUDIO)).toEqual({ status: 'synced' });
	expect(alice.replica.notSent()).toEqual([]);
	expect(world.server.read(NOTE)).not.toBeNull();
});

test("a person's separate attach never blocks a note", () => {
	const { world, alice, settle } = setup();
	alice.replica.write(AUDIO, writePointer(a));
	alice.replica.write(NOTE, note('', `title: R1\naudio: ${AUDIO}`));
	settle();
	expect(world.server.read(NOTE)).not.toBeNull();
	expect(alice.replica.state(NOTE)).toEqual({ status: 'synced' });
	expect(alice.replica.state(AUDIO)).toEqual(UPLOADING);
	expect(world.server.read(AUDIO)).toBeNull();
});

test('a pointer deleted before its upload sends nothing, and its bytes are no longer owed', () => {
	const { world, alice, settle, sent } = setup();
	alice.replica.write(AUDIO, writePointer(a));
	settle();
	alice.replica.write(AUDIO, null);
	expect(alice.replica.owed()).toEqual([]);
	settle();
	expect(sent(AUDIO)).toBe(false);
	expect(world.server.read(AUDIO)).toBeNull();
	expect(alice.replica.read(AUDIO)).toBeNull();
	expect(alice.replica.busy()).toBe(false);
});

test('two devices with the same bytes at one path: one upload, one file', () => {
	const { world, alice, bob, settle } = setup();
	alice.replica.write(AUDIO, writePointer(a));
	bob.replica.write(AUDIO, writePointer(a));
	settle();
	world.upload(a.oid, a.size);
	// Each device's upload track asks; the server already holds the bytes for the second.
	for (const device of [alice, bob]) device.replica.present(a.oid, a.size);
	settle();
	expect([...world.server.snapshot().keys()]).toEqual([AUDIO]);
	expect(world.server.read(AUDIO)).toBe(writePointer(a));
	for (const device of [alice, bob]) expect(device.replica.state(AUDIO)).toEqual({ status: 'synced' });
});

test('a refused upload holds every pointer naming those bytes; a save of the path clears it; the same bytes saved again are owed again', () => {
	const { world, alice, settle, sent } = setup();
	alice.replica.writeAll({ [AUDIO]: writePointer(a), 'recordings/copy.webm': writePointer(a) });
	alice.replica.refused(a.oid, 'the file is larger than this repository allows');
	const held: FileStatus = { status: 'waiting', reason: 'the file is larger than this repository allows' };
	expect(alice.replica.state(AUDIO)).toEqual(held);
	expect(alice.replica.state('recordings/copy.webm')).toEqual(held);
	expect(alice.replica.owed()).toEqual([]);
	alice.replica.write(AUDIO, null);
	expect(alice.replica.read(AUDIO)).toBeNull();
	alice.replica.write('recordings/again.webm', writePointer(a));
	expect(alice.replica.state('recordings/again.webm')).toEqual(UPLOADING);
	expect(alice.replica.owed()).toEqual([a]);
	settle();
	expect(sent(AUDIO) || sent('recordings/copy.webm') || sent('recordings/again.webm')).toBe(false);
	expect(world.server.snapshot().size).toBe(0);
});

test('owed pointers survive a reopen, and count as busy and unsent', () => {
	const { alice, settle } = setup();
	alice.setOnline(false);
	alice.replica.writeAll({ [AUDIO]: writePointer(a), 'recordings/r2.webm': writePointer(b) });
	alice.restart();
	expect(alice.replica.owed()).toEqual([a, b]);
	expect(alice.replica.state(AUDIO)).toEqual(UPLOADING);
	expect(alice.replica.unsent()).toEqual([AUDIO, 'recordings/r2.webm']);
	alice.setOnline(true);
	settle();
	expect(alice.replica.busy()).toBe(true);
	alice.replica.present(a.oid, a.size);
	alice.replica.refused(b.oid, 'refused');
	settle();
	expect(alice.replica.busy()).toBe(false);
});

test('a blob written elsewhere while this one uploads: this one is uploaded still, and lands beside it', () => {
	const { world, alice, bob, settle } = setup();
	world.upload(b.oid, b.size);
	alice.setOnline(false);
	alice.replica.write(AUDIO, writePointer(a));
	bob.replica.present(b.oid, b.size);
	bob.replica.write(AUDIO, writePointer(b));
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read(AUDIO)).toBe(writePointer(b));
	expect(alice.replica.read(AUDIO)).toBe(writePointer(a));
	expect(alice.replica.state(AUDIO)).toEqual(UPLOADING);
	expect(alice.replica.owed()).toEqual([a]);
	world.upload(a.oid, a.size);
	alice.replica.present(a.oid, a.size);
	settle();
	expect(world.server.read(AUDIO)).toBe(writePointer(b));
	expect(world.server.read(beside(a))).toBe(writePointer(a));
	expect(alice.replica.read(AUDIO)).toBe(writePointer(b));
	expect(alice.replica.busy()).toBe(false);
});

test('a pointer saved over an owed pointer while a commit is out: the notes go, neither pointer before its bytes, and the newer once present (seeds 470249, 470282)', () => {
	const { world, alice, settle, pushed } = setup();
	const c = { oid: 'c'.repeat(64), size: 300 };
	const d = { oid: 'd'.repeat(64), size: 400 };
	world.upload(c.oid, c.size);
	alice.replica.present(c.oid, c.size);
	// A commit in flight whose reply is lost; while it is out, an owed pointer is saved with notes, then another over it.
	alice.loseNextReply();
	alice.replica.writeAll({ 'notes/b.md': note('b\n'), [AUDIO]: writePointer(c) });
	world.net.runFor(5);
	alice.replica.writeAll({ 'notes/a.md': note('a\n'), 'notes/c.md': note('c\n'), [AUDIO]: writePointer(a) });
	alice.replica.writeAll({ 'notes/a.md': note('a\nmore\n'), [AUDIO]: writePointer(d) });
	settle();
	// Each pointer sent, once however often its commit was sent again.
	const sentPointers = () => [...new Set(pushed.flatMap(({ commit }) => commit.files.filter((file) => file.path === AUDIO).map((file) => file.text)))];
	expect(sentPointers()).toEqual([writePointer(c)]);
	expect(world.server.read('notes/a.md')).toBe(note('a\nmore\n'));
	expect(world.server.read('notes/c.md')).toBe(note('c\n'));
	expect(alice.replica.state(AUDIO)).toEqual(UPLOADING);
	world.upload(d.oid, d.size);
	alice.replica.present(d.oid, d.size);
	settle();
	expect(sentPointers()).toEqual([writePointer(c), writePointer(d)]);
	expect(world.server.read(AUDIO)).toBe(writePointer(d));
});

test("a pointer equal to main's, saved while a change to its path is in flight, is owed until its bytes are present, even under a later save (seeds 470249, 470282)", () => {
	const { world, alice, bob, settle, pushed } = setup();
	world.upload(a.oid, a.size);
	bob.replica.present(a.oid, a.size);
	bob.replica.write(AUDIO, writePointer(a));
	settle();
	expect(alice.replica.read(AUDIO)).toBe(writePointer(a));
	pushed.length = 0;
	// Alice's delete goes out; while it is in flight she attaches `main`'s bytes again, then other bytes over them.
	alice.replica.write(AUDIO, null);
	alice.replica.write(AUDIO, writePointer(a));
	alice.replica.write(AUDIO, writePointer(b));
	settle();
	// The delete landed, so `a` is no longer `main`'s: it never went, and only `b` is owed.
	expect(pushed.map(({ commit }) => commit.files.map((f) => f.text))).toEqual([[null]]);
	expect(alice.replica.owed()).toEqual([b]);
	world.upload(b.oid, b.size);
	alice.replica.present(b.oid, b.size);
	settle();
	expect(pushed.map(({ commit }) => commit.files.map((f) => f.text))).toEqual([[null], [writePointer(b)]]);
	expect(world.server.read(AUDIO)).toBe(writePointer(b));
	expect(alice.replica.busy()).toBe(false);
});

test('a blob replace made over bytes that were deleted and attached again since lands: compare-and-swap is on the bytes, not their history (seed 471236)', () => {
	const { world, alice, bob, settle } = setup();
	for (const bytes of [a, b]) world.upload(bytes.oid, bytes.size);
	for (const device of [alice, bob]) for (const bytes of [a, b]) device.replica.present(bytes.oid, bytes.size);
	bob.replica.write(AUDIO, writePointer(a));
	settle();
	alice.setOnline(false);
	alice.replica.write(AUDIO, writePointer(b));
	bob.replica.write(AUDIO, null);
	settle();
	bob.replica.write(AUDIO, writePointer(a));
	settle();
	alice.setOnline(true);
	settle();
	expect(world.server.read(AUDIO)).toBe(writePointer(b));
	for (const device of [alice, bob]) expect(device.replica.state(AUDIO)).toEqual({ status: 'synced' });
});

test('a note saved with a blob that lost goes on its own; the blob lands beside, and new bytes over what she then sees go only once present (W seed 211163)', () => {
	const { world, alice, bob, settle, pushed } = setup();
	const c = { oid: 'c'.repeat(64), size: 10 };
	for (const bytes of [a, b]) world.upload(bytes.oid, bytes.size);
	for (const device of [alice, bob]) for (const bytes of [a, b]) device.replica.present(bytes.oid, bytes.size);
	alice.replica.write(NOTE, note('one\n'));
	settle();
	pushed.length = 0;
	alice.setOnline(false);
	// One save of the note and a blob; someone replaces the blob, so at catch-up her blob write has lost, and goes saying what it was made over.
	alice.replica.writeAll({ [NOTE]: note('two\n'), [AUDIO]: writePointer(a) });
	bob.replica.write(AUDIO, writePointer(b));
	settle();
	alice.restart();
	alice.setOnline(true);
	settle();
	expect(world.server.read(NOTE)).toBe(note('two\n'));
	expect(world.server.read(beside(a))).toBe(writePointer(a));
	expect(alice.replica.read(AUDIO)).toBe(writePointer(b));
	// Her new bytes over what she sees owe their upload; the note's next save goes without them.
	alice.replica.write(AUDIO, writePointer(c));
	alice.replica.write(NOTE, note('three\n'));
	settle();
	expect(world.server.read(NOTE)).toBe(note('three\n'));
	expect(alice.replica.owed()).toEqual([c]);
	const sentAudio = () => pushed.filter(({ device }) => device === 'alice').flatMap(({ commit }) => commit.files.filter((f) => f.path === AUDIO).map((f) => f.text));
	expect(sentAudio()).toEqual([writePointer(a)]);
	world.upload(c.oid, c.size);
	alice.replica.present(c.oid, c.size);
	settle();
	expect(sentAudio()).toEqual([writePointer(a), writePointer(c)]);
	expect(world.server.read(AUDIO)).toBe(writePointer(c));
});
