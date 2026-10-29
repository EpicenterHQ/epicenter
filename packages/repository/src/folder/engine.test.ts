/**
 * Folder Engine Tests
 *
 * The folder engine (`engine.ts`) in the memory world: a memory folder, a
 * replica on the world's server, and other devices, on virtual time. The
 * property test (`sim/folder.property.test.ts`) covers the rules under
 * random interleavings; these name each rule once.
 *
 * Key behaviors:
 * - A save in the folder reaches the server; a change from elsewhere reaches the file; the engine's own write never comes back as a save
 * - A rename is one group: one commit holds both halves
 * - A save that lands while the engine writes the file is captured and merged, never destroyed
 * - A crash between the capture and the link puts the file back, and nothing reads it as a delete
 * - `commit` sends every difference as one commit carrying the message; nothing differing changes nothing
 * - A `.md` file that is not UTF-8 is listed as unreadable, never sent, never overwritten; dot paths and editor droppings are never sent
 * - A blob in the folder is sealed, uploaded, and lands; one from elsewhere is fetched before its file is written
 */
import { expect, test } from 'bun:test';
import { findConflicts } from '../core/conflict.js';
import { parsePointer } from '../core/markdown.js';
import type { World } from '../sim/harness.js';
import { createWorld } from '../sim/harness.js';
import { createFolderDevice, type Lfs, runFor, step, until, uploadBlob } from '../sim/folder.test-support.js';

const note = (body: string, title = 'A') => `---\ntitle: ${title}\n---\n${body}`;
const encoder = new TextEncoder();

/** The commits `device` sent that landed, as their message and paths. */
function landed(world: World, device = 'ada') {
	const commits: { message?: string; paths: string[] }[] = [];
	world.onRequest((from, request, reply) => {
		if (from !== device || request.type !== 'push' || reply.type !== 'answer' || (reply.answer.kind !== 'applied' && reply.answer.kind !== 'merged')) return;
		if (commits.some((c) => c.paths.join() === request.commit.files.map((f) => f.path).sort().join() && c.message === request.commit.message)) return;
		commits.push({ ...(request.commit.message === undefined ? {} : { message: request.commit.message }), paths: request.commit.files.map((f) => f.path).sort() });
	});
	return commits;
}

async function setup() {
	const world = createWorld({ seed: 7, latency: { min: 1, max: 5 } });
	const lfs: Lfs = new Map();
	const folder = createFolderDevice(world, 'ada', { lfs });
	const other = world.device('bo');
	await until(world, folder.start());
	await runFor(world, 1_000);
	const pushes = () => world.counts().push;
	return { world, lfs, folder, other, pushes };
}

test('a save in the folder reaches the server, a change from elsewhere reaches the file, and the engine never hears its own write as a save', async () => {
	const { world, folder, other } = await setup();
	folder.disk.write('notes/a.md', encoder.encode(note('one\n')));
	await runFor(world, 2_000);
	expect(world.server.read('notes/a.md')).toBe(note('one\n'));
	other.replica.write('notes/a.md', note('one\ntwo\n'));
	await runFor(world, 2_000);
	expect(folder.disk.text('notes/a.md')).toBe(note('one\ntwo\n'));
	const before = folder.replica.stats().pushes;
	await runFor(world, 5_000);
	await until(world, folder.engine.scan());
	await runFor(world, 2_000);
	expect(folder.replica.stats().pushes).toBe(before);
	expect(folder.disk.violations).toEqual([]);
});

test('a rename is one group: one commit holds both halves', async () => {
	const { world, folder } = await setup();
	folder.disk.write('notes/a.md', encoder.encode(note('one\n')));
	await runFor(world, 2_000);
	const commits = landed(world);
	folder.disk.rename('notes/a.md', 'notes/b.md');
	await runFor(world, 2_000);
	expect(commits).toEqual([{ paths: ['notes/a.md', 'notes/b.md'] }]);
	expect(world.server.read('notes/b.md')).toBe(note('one\n'));
	expect(world.server.read('notes/a.md')).toBeNull();
});

test('a directory moved is every file under it moved, each pair one group', async () => {
	const { world, folder } = await setup();
	folder.disk.write('trip/a.md', encoder.encode(note('a\n')));
	folder.disk.write('trip/b.md', encoder.encode(note('b\n', 'B')));
	await runFor(world, 2_000);
	folder.disk.rename('trip', 'travel');
	await runFor(world, 2_000);
	expect(world.server.snapshot()).toEqual(
		new Map([
			['travel/a.md', note('a\n')],
			['travel/b.md', note('b\n', 'B')],
		]),
	);
});

test('a save that lands while the engine writes the file is captured and merged, never destroyed', async () => {
	const { world, folder, other } = await setup();
	folder.disk.write('notes/a.md', encoder.encode(note('one\n')));
	await runFor(world, 2_000);
	// An editor holds the file open; a remote change arrives; the editor writes through its descriptor just as the engine takes the file aside.
	const ino = folder.disk.inodeOf('notes/a.md') as number;
	other.replica.write('notes/a.md', note('one\nremote\n'));
	let wrote = false;
	for (let n = 0; n < 5_000 && !wrote; n++) {
		await step(world);
		if (folder.disk.text('notes/a.md') === null && folder.disk.scratchNames().length > 0) wrote = folder.disk.writeInode(ino, encoder.encode(note('local\none\n')));
	}
	expect(wrote).toBe(true);
	await runFor(world, 3_000);
	const text = world.server.read('notes/a.md') ?? '';
	expect(text).toContain('local');
	expect(text).toContain('remote');
	expect(folder.disk.text('notes/a.md')).toBe(text);
	expect(folder.disk.violations).toEqual([]);
	expect(folder.disk.scratchNames()).toEqual([]);
});

test('a crash between the capture and the link puts the file back; nothing reads it as a delete', async () => {
	const { world, folder, other } = await setup();
	folder.disk.write('notes/a.md', encoder.encode(note('one\n')));
	await runFor(world, 2_000);
	other.replica.write('notes/a.md', note('one\nremote\n'));
	for (let n = 0; n < 5_000; n++) {
		await step(world);
		if (folder.disk.text('notes/a.md') === null && folder.disk.scratchNames().length > 0) break;
	}
	expect(folder.disk.text('notes/a.md')).toBeNull();
	await folder.crash();
	await until(world, folder.engine.idle());
	await runFor(world, 3_000);
	expect(world.server.read('notes/a.md')).toBe(note('one\nremote\n'));
	expect(folder.disk.text('notes/a.md')).toBe(note('one\nremote\n'));
	expect(folder.disk.violations).toEqual([]);
});

test('commit sends every difference as one commit carrying the message; nothing differing changes nothing', async () => {
	const world = createWorld({ seed: 3, latency: { min: 1, max: 5 } });
	const lfs: Lfs = new Map();
	const folder = createFolderDevice(world, 'ada', { lfs });
	await until(world, folder.start({ watch: false }));
	await runFor(world, 1_000);
	folder.disk.write('notes/a.md', encoder.encode(note('a\n')));
	folder.disk.write('notes/b.md', encoder.encode(note('b\n', 'B')));
	const commits = landed(world);
	expect((await until(world, folder.engine.commit('Two notes'))).sort()).toEqual(['notes/a.md', 'notes/b.md']);
	await runFor(world, 2_000);
	expect(commits).toEqual([{ message: 'Two notes', paths: ['notes/a.md', 'notes/b.md'] }]);
	expect(await until(world, folder.engine.commit('Again'))).toEqual([]);
});

test('a .md file that is not UTF-8 is unreadable: never sent, never overwritten; dot paths and droppings are never sent', async () => {
	const { world, folder, other } = await setup();
	folder.disk.write('notes/bad.md', new Uint8Array([0xff, 0xfe, 0x41]));
	folder.disk.write('.obsidian/workspace.json', encoder.encode('{}'));
	folder.disk.write('notes/a.md~', encoder.encode('backup'));
	folder.disk.write('4913', encoder.encode(''));
	folder.disk.write('.DS_Store', encoder.encode('x'));
	await runFor(world, 2_000);
	expect(folder.engine.unreadable()).toEqual([{ path: 'notes/bad.md', reason: 'not UTF-8 text' }]);
	expect([...world.server.snapshot().keys()]).toEqual([]);
	other.replica.write('notes/bad.md', note('remote\n'));
	await runFor(world, 2_000);
	expect(folder.disk.bytes('notes/bad.md')).toEqual(new Uint8Array([0xff, 0xfe, 0x41]));
	folder.disk.write('notes/bad.md', encoder.encode(note('readable\n')));
	await runFor(world, 2_000);
	expect(folder.engine.unreadable()).toEqual([]);
	const merged = world.server.read('notes/bad.md') ?? '';
	expect(merged).toContain('readable');
	expect(findConflicts(merged).length > 0 || merged.includes('remote')).toBe(true);
});

test("a blob saved in the folder is sealed, uploaded and lands; one from elsewhere is fetched before its file is written", async () => {
	const { world, lfs, folder, other } = await setup();
	const bytes = encoder.encode('png bytes');
	folder.disk.write('media/a.png', bytes);
	await runFor(world, 2_000);
	expect(folder.replica.state('media/a.png')).toEqual({ status: 'sending', reason: 'its bytes are uploading' });
	await until(world, folder.upload());
	await runFor(world, 2_000);
	expect(world.server.read('media/a.png')).toContain('oid sha256:');
	const pointer = uploadBlob(world, lfs, encoder.encode('webm bytes'));
	other.replica.write('media/b.webm', pointer);
	const sealed = parsePointer(pointer);
	if (sealed !== null) other.replica.present(sealed.oid, sealed.size);
	await runFor(world, 2_000);
	expect(folder.disk.text('media/b.webm')).toBe('webm bytes');
});
