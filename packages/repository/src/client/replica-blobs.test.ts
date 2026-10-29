/**
 * Replica Blob Tests
 *
 * The replica's gate on blobs, in the memory world: a pointer whose bytes
 * the server does not hold yet is owed, and an owed pointer stays saved on
 * this device and out of every commit until the upload track marks its
 * bytes present. Owed is derived, never stored: a file whose text is a
 * pointer this device made, whose oid is neither present nor refused.
 *
 * A pointer joins the group of the call that saved it: a group goes in one
 * commit, so it waits for every byte it names and is held whole when any of
 * it is refused. Separate calls are separate groups.
 *
 * Key behaviors:
 * - An owed pointer is never sent, nor the note saved with it in one call; both go in one commit once its bytes are present
 * - A batch of two notes and a new blob, with a delayed upload across typing elsewhere, lands as one commit
 * - A refused upload, or a blob write that lost on the server, holds the whole group it was saved with
 * - A person's separate attach never blocks a note: the note saved in its own call goes at once
 * - A pointer deleted before its upload sends nothing, and its bytes are no longer owed
 * - Two devices with the same bytes at one path: one upload, one file
 * - A refused upload holds every pointer naming those bytes, with the reason; a save of the path clears it, and saving the same bytes again owes them again
 * - Owed pointers survive a reopen, and count as busy and unsent
 * - A blob write over a blob that moved while its bytes were uploading is held with why, and never uploaded
 * - A blob refusal that no held text stands under (a later save over it took `main`'s blob) joins no calls, so a message lands in one commit
 */
import { expect, test } from 'bun:test';
import type { LiveCommit } from '../core/commit.js';
import { writePointer } from '../core/markdown.js';
import { createWorld } from '../sim/harness.js';
import type { FileStatus } from './replica.js';

const note = (body: string, fields = 'title: R1') => `---\n${fields}\n---\n${body}`;
const AUDIO = 'recordings/r1.webm';
const NOTE = 'recordings/r1.md';
const a = { oid: 'a'.repeat(64), size: 3_145_728 };
const b = { oid: 'b'.repeat(64), size: 1_000 };
const UPLOADING: FileStatus = { status: 'sending', reason: 'its bytes are uploading' };

function setup(names = ['alice', 'bob']) {
	const world = createWorld({ latency: { min: 20, max: 20 } });
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

test('an owed pointer is never sent, nor the note saved with it in one call; both go in one commit once its bytes are present', () => {
	const { world, alice, settle, sent, pushed } = setup();
	alice.setOnline(false);
	alice.replica.writeAll({ [NOTE]: note('', `title: R1\naudio: ${AUDIO}`), [AUDIO]: writePointer(a) });
	expect(alice.replica.state(AUDIO)).toEqual(UPLOADING);
	expect(alice.replica.state(NOTE)).toEqual({ status: 'sending', reason: `saved with ${AUDIO}, whose bytes are uploading` });
	expect(alice.replica.owed()).toEqual([a]);
	alice.setOnline(true);
	settle();
	expect(sent(NOTE) || sent(AUDIO)).toBe(false);
	expect(world.server.read(NOTE)).toBeNull();
	expect(alice.replica.busy()).toBe(true);
	// The upload track: the bytes reach the server, then this device marks them present.
	world.upload(a.oid, a.size);
	alice.replica.present(a.oid, a.size);
	expect(alice.replica.owed()).toEqual([]);
	settle();
	expect(world.server.read(AUDIO)).toBe(writePointer(a));
	expect(world.server.read(NOTE)).not.toBeNull();
	expect(pushed.map(({ commit }) => commit.files.map((f) => f.path).sort())).toEqual([[NOTE, AUDIO].sort()]);
	for (const path of [NOTE, AUDIO]) expect(alice.replica.state(path)).toEqual({ status: 'synced' });
});

test('a batch of two notes and a new blob, with a delayed upload across typing elsewhere, lands as one commit', () => {
	const { world, alice, bob, settle, pushed } = setup();
	bob.replica.writeAll({ 'notes/one.md': note('one\n'), 'notes/two.md': note('two\n') });
	settle();
	alice.replica.writeAll({ 'notes/one.md': note('one\nagent\n'), 'notes/two.md': note('agent\ntwo\n'), [AUDIO]: writePointer(a) });
	// Typing elsewhere while the bytes upload.
	for (const word of ['x', 'y', 'z']) {
		bob.replica.edit('notes/one.md', (text) => `${text}${word}\n`);
		settle();
	}
	expect(world.server.read(AUDIO)).toBeNull();
	world.upload(a.oid, a.size);
	alice.replica.present(a.oid, a.size);
	settle();
	const mine = pushed.filter(({ device }) => device === 'alice').map(({ commit }) => commit.files.map((f) => f.path).sort());
	expect(mine).toEqual([['notes/one.md', 'notes/two.md', AUDIO].sort()]);
	for (const word of ['agent', 'x', 'y', 'z']) expect(world.server.read('notes/one.md')).toContain(`${word}\n`);
	expect(world.server.read('notes/two.md')).toBe(note('agent\ntwo\n'));
	expect(world.server.read(AUDIO)).toBe(writePointer(a));
});

test('a refused upload holds the whole group it was saved with; a save of the blob lets the rest go', () => {
	const { world, alice, settle, sent } = setup();
	alice.replica.writeAll({ [NOTE]: note('', `title: R1\naudio: ${AUDIO}`), [AUDIO]: writePointer(a) });
	alice.replica.refused(a.oid, 'over the quota');
	settle();
	expect(alice.replica.state(AUDIO)).toEqual({ status: 'held', reason: 'over the quota' });
	expect(alice.replica.state(NOTE)).toEqual({ status: 'held', reason: `saved with ${AUDIO}, which is held` });
	expect(sent(NOTE)).toBe(false);
	// Its person drops the recording: the note goes.
	alice.replica.write(AUDIO, null);
	settle();
	expect(world.server.read(NOTE)).not.toBeNull();
	expect(world.server.read(AUDIO)).toBeNull();
});

test('a blob write that lost on the server holds the whole group it was saved with', () => {
	const { world, alice, bob, settle, sent } = setup();
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
	expect(alice.replica.state(AUDIO)).toEqual({ status: 'held', reason: 'a file with this name was just added elsewhere' });
	expect(alice.replica.state(NOTE)).toEqual({ status: 'held', reason: `saved with ${AUDIO}, which is held` });
	expect(world.server.read(NOTE)).toBeNull();
	expect(sent(NOTE) && world.server.read(NOTE) !== null).toBe(false);
});

test("a person's separate attach never blocks a note: the note saved in its own call goes at once", () => {
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
	const held: FileStatus = { status: 'held', reason: 'the file is larger than this repository allows' };
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

test('a blob written elsewhere while this one uploads holds this one with why, and its bytes are not uploaded', () => {
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
	expect(alice.replica.state(AUDIO)).toEqual({ status: 'held', reason: 'a file with this name was just added elsewhere' });
	expect(alice.replica.owed()).toEqual([]);
});

test('a blob refusal that does not stand joins no calls: a message lands in one commit when a later save over its blob is dropped (seed 1300099)', () => {
	const { world, alice, bob, settle } = setup();
	const c = { oid: 'c'.repeat(64), size: 10 };
	/** Alice's commits the server took, in order. */
	const landed: LiveCommit[] = [];
	world.onRequest((device, request, reply) => {
		if (device === 'alice' && request.type === 'push' && reply.type === 'answer' && (reply.answer.kind === 'applied' || reply.answer.kind === 'merged')) landed.push(request.commit);
	});
	for (const bytes of [a, b, c]) world.upload(bytes.oid, bytes.size);
	for (const device of [alice, bob]) for (const bytes of [a, b, c]) device.replica.present(bytes.oid, bytes.size);
	alice.replica.write(AUDIO, writePointer(b));
	settle();
	landed.length = 0;
	alice.setOnline(false);
	// A call with a message, then a later save without one over its blob: the later save waits for that commit.
	alice.replica.writeAll({ [NOTE]: note('said\n'), [AUDIO]: writePointer(a) }, { message: 'Said' });
	alice.replica.writeAll({ [AUDIO]: null, 'recordings/r2.webm': writePointer(a) });
	// Someone replaces the blob; alice catches up before she sends: the message's write is refused there, and the later delete over it is dropped.
	bob.replica.write(AUDIO, writePointer(c));
	settle();
	alice.restart();
	alice.setOnline(true);
	settle();
	expect(landed.map((commit) => [commit.message ?? null, commit.files.map((f) => f.path).sort()])).toEqual([
		['Said', [NOTE]],
		[null, ['recordings/r2.webm']],
	]);
	expect(alice.replica.read(AUDIO)).toBe(writePointer(c));
	expect(alice.replica.busy()).toBe(false);
});
