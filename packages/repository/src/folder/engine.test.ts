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
 * - A rename is a delete and a create, each going on its own: both land, and a new name the repository cannot take is held alone while the delete lands
 * - A save that lands while the engine writes the file is captured and merged, never destroyed
 * - A captured file still being written is read once it is still, so a half-written save never goes in
 * - A file made while the engine has the path captured was made over nothing, so nothing the engine took aside is deleted by it
 * - A crash between the capture and the link puts the file back, and nothing reads it as a delete
 * - A stopped folder's scan (`sync --once`) sends every difference; nothing differing sends nothing
 * - Files the repository cannot take are held alone, wherever the refusal is found; the rest lands, and each lands once fixed
 * - A `.md` file that is not UTF-8 is held, never sent, never overwritten; dot paths and editor droppings are never sent
 * - Two files whose names differ only in letters (a case-sensitive file system) are held, and the repository takes neither; the engine never writes such a pair itself
 * - A blob in the folder is sealed, uploaded, and lands; one from elsewhere is fetched before its file is written
 * - A file made offline where another device made a folder is held with why; the folder's files are never erased, and once the person renames the file both land
 * - A file replaced by a folder of its name between two looks is a delete and the folder's files, one group
 */
import { expect, test } from 'bun:test';
import { findConflicts } from '../core/conflict.js';
import { parsePointer } from '../core/markdown.js';
import { createWorld } from '../sim/harness.js';
import { TWIN } from './engine.js';
import { BlobStoreError } from '../client/blobs.js';
import { fold } from '../core/door.js';
import { createFolderDevice, type Lfs, runFor, step, until, uploadBlob } from '../sim/folder.test-support.js';

const note = (body: string, title = 'A') => `---\ntitle: ${title}\n---\n${body}`;
const encoder = new TextEncoder();

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

test('a rename is a delete and a create: both land', async () => {
	const { world, folder } = await setup();
	folder.disk.write('notes/a.md', encoder.encode(note('one\n')));
	await runFor(world, 2_000);
	folder.disk.rename('notes/a.md', 'notes/b.md');
	await runFor(world, 2_000);
	expect(world.server.read('notes/b.md')).toBe(note('one\n'));
	expect(world.server.read('notes/a.md')).toBeNull();
});

test('a rename to a name the repository cannot take: the delete lands alone, and the text waits in the new file, held with why', async () => {
	const { world, folder } = await setup();
	folder.disk.write('notes/a.md', encoder.encode(note('one\n')));
	folder.disk.write('notes/todo.md', encoder.encode(note('todo\n')));
	await runFor(world, 2_000);
	// On a case-sensitive disk, a.md renamed beside todo.md under a name that folds to it.
	folder.disk.rename('notes/a.md', 'notes/Todo.md');
	await runFor(world, 2_000);
	expect(world.server.read('notes/a.md')).toBeNull();
	expect(folder.replica.held()).toEqual([{ path: 'notes/Todo.md', reason: TWIN }]);
	expect(folder.disk.text('notes/Todo.md')).toBe(note('one\n'));
	// Renamed again, it lands.
	folder.disk.rename('notes/Todo.md', 'notes/b.md');
	await runFor(world, 2_000);
	expect(world.server.read('notes/b.md')).toBe(note('one\n'));
	expect(folder.replica.held()).toEqual([]);
});

test('a directory moved is every file under it moved', async () => {
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

test('a file captured mid-save (truncated, its bytes not yet written) is read once it is still: the save goes in once', async () => {
	const { world, folder, other } = await setup();
	folder.disk.write('notes/a.md', encoder.encode(note('one\n')));
	await runFor(world, 2_000);
	// An editor saving in place truncates the file just before the engine takes it aside, and writes its bytes through its descriptor after.
	const ino = folder.disk.inodeOf('notes/a.md') as number;
	const replace = folder.disk.port.replace;
	let raced = false;
	folder.disk.port.replace = (path, bytes, options) => {
		if (!raced && path === 'notes/a.md') {
			raced = true;
			folder.disk.writeInode(ino, new Uint8Array());
			world.net.after(40, () => folder.disk.writeInode(ino, encoder.encode(note('one\nlocal\n'))));
		}
		return replace(path, bytes, options);
	};
	const sent: (string | null)[] = [];
	world.onRequest((from, request) => {
		if (from === 'ada' && request.type === 'push') for (const file of request.commit.files) sent.push(file.text);
	});
	other.replica.write('notes/a.md', note('one\nremote\n'));
	await runFor(world, 3_000);
	expect(raced).toBe(true);
	// The empty file is never a save: no text sent drops the line the person kept.
	expect(sent.filter((text) => !text?.includes('one'))).toEqual([]);
	const text = world.server.read('notes/a.md') ?? '';
	expect(text.match(/local/g)).toHaveLength(1);
	expect(text).toContain('remote');
	expect(findConflicts(text)).toEqual([]);
	expect(folder.disk.text('notes/a.md')).toBe(text);
	expect(folder.disk.violations).toEqual([]);
});

test('a file made in the instant the engine has the path captured was made over nothing: what the engine took aside is kept', async () => {
	const { world, folder, other } = await setup();
	folder.disk.write('notes/a.md', encoder.encode(note('one\nmine\n')));
	await runFor(world, 2_000);
	other.replica.write('notes/a.md', note('one\nmine\nremote\n'));
	// An appender (`echo x >> notes/a.md`) runs while the path is empty between the engine's capture and its link: it creates a file holding only its line.
	let made = false;
	for (let n = 0; n < 5_000 && !made; n++) {
		await step(world);
		if (folder.disk.text('notes/a.md') === null && folder.disk.scratchNames().length > 0) made = folder.disk.write('notes/a.md', encoder.encode('appended\n'));
	}
	expect(made).toBe(true);
	await runFor(world, 3_000);
	const text = world.server.read('notes/a.md') ?? '';
	expect(text).toContain('appended');
	expect(text).toContain('mine');
	expect(text).toContain('remote');
	expect(folder.disk.text('notes/a.md')).toBe(text);
	expect(folder.disk.violations).toEqual([]);
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

test("a stopped folder's scan sends every difference; nothing differing sends nothing", async () => {
	const world = createWorld({ seed: 3, latency: { min: 1, max: 5 } });
	const lfs: Lfs = new Map();
	const folder = createFolderDevice(world, 'ada', { lfs });
	await until(world, folder.start({ watch: false }));
	await runFor(world, 1_000);
	folder.disk.write('notes/a.md', encoder.encode(note('a\n')));
	folder.disk.write('notes/b.md', encoder.encode(note('b\n', 'B')));
	await runFor(world, 1_000);
	await until(world, folder.engine.scan());
	await runFor(world, 2_000);
	expect(world.server.read('notes/a.md')).toBe(note('a\n'));
	expect(world.server.read('notes/b.md')).toBe(note('b\n', 'B'));
	const pushes = folder.replica.stats().pushes;
	await until(world, folder.engine.scan());
	await runFor(world, 2_000);
	expect(folder.replica.stats().pushes).toBe(pushes);
});

test('a note read with CRLF endings or a byte order mark lands normalized, and the file is never written back', async () => {
	const { world, folder, other } = await setup();
	const windows = encoder.encode(`\uFEFF${note('one\ntwo\n').replaceAll('\n', '\r\n')}`);
	folder.disk.write('notes/w.md', windows);
	await runFor(world, 2_000);
	expect(world.server.read('notes/w.md')).toBe(note('one\ntwo\n'));
	expect(folder.replica.held()).toEqual([]);
	expect(folder.replica.state('notes/w.md')).toEqual({ status: 'synced' });
	// Recorded as read: a scan finds nothing to send, and the file keeps its bytes.
	const before = folder.replica.stats().pushes;
	await runFor(world, 5_000);
	await until(world, folder.engine.scan());
	await runFor(world, 2_000);
	expect(folder.replica.stats().pushes).toBe(before);
	expect(folder.disk.bytes('notes/w.md')).toEqual(windows);
	// A change from elsewhere is written as the repository holds it.
	other.replica.write('notes/w.md', note('one\ntwo\nthree\n'));
	await runFor(world, 2_000);
	expect(folder.disk.text('notes/w.md')).toBe(note('one\ntwo\nthree\n'));
});

test('a .md file that is not UTF-8 is held: never sent, never overwritten; dot paths and droppings are never sent', async () => {
	const { world, folder, other } = await setup();
	folder.disk.write('notes/bad.md', new Uint8Array([0xff, 0xfe, 0x41]));
	folder.disk.write('.obsidian/workspace.json', encoder.encode('{}'));
	folder.disk.write('notes/a.md~', encoder.encode('backup'));
	folder.disk.write('4913', encoder.encode(''));
	folder.disk.write('.DS_Store', encoder.encode('x'));
	await runFor(world, 2_000);
	expect(folder.replica.held()).toEqual([{ path: 'notes/bad.md', reason: 'not UTF-8 text' }]);
	expect([...world.server.snapshot().keys()]).toEqual([]);
	other.replica.write('notes/bad.md', note('remote\n'));
	await runFor(world, 2_000);
	expect(folder.disk.bytes('notes/bad.md')).toEqual(new Uint8Array([0xff, 0xfe, 0x41]));
	folder.disk.write('notes/bad.md', encoder.encode(note('readable\n')));
	await runFor(world, 2_000);
	expect(folder.replica.held()).toEqual([]);
	const merged = world.server.read('notes/bad.md') ?? '';
	expect(merged).toContain('readable');
	expect(findConflicts(merged).length > 0 || merged.includes('remote')).toBe(true);
});

test('files the repository cannot take are held alone, wherever the refusal is found; the rest lands, and each lands once fixed', async () => {
	const { world, folder } = await setup();
	folder.disk.write('notes/todo.md', encoder.encode(note('one\n')));
	await runFor(world, 2_000);
	// A note that is not UTF-8, a name that folds to another file's, and bytes the device cannot store: none is a save the repository can take.
	folder.disk.write('notes/a.md', encoder.encode(note('a\n')));
	folder.disk.write('notes/bad.md', new Uint8Array([0xff, 0xfe, 0x41]));
	folder.disk.write('notes/Todo.md', encoder.encode(note('twin\n')));
	const seal = folder.store.seal;
	folder.store.seal = async () => BlobStoreError.QuotaExceeded({ cause: 'full' });
	folder.disk.write('media/a.png', encoder.encode('png'));
	await runFor(world, 2_000);
	expect(folder.replica.held()).toEqual([
		{ path: 'media/a.png', reason: 'This device has no room left for these bytes' },
		{ path: 'notes/Todo.md', reason: TWIN },
		{ path: 'notes/bad.md', reason: 'not UTF-8 text' },
	]);
	// What can go went: nothing waits on a held file.
	expect(world.server.read('notes/a.md')).toBe(note('a\n'));
	expect(folder.replica.state('notes/a.md')).toEqual({ status: 'synced' });
	// The store has room again: the next look (a periodic scan) reads the bytes once more and takes them.
	folder.store.seal = seal;
	await until(world, folder.engine.scan());
	await until(world, folder.upload());
	await runFor(world, 2_000);
	expect(world.server.read('media/a.png')).not.toBeNull();
	// The person fixes each; each lands.
	folder.disk.write('notes/bad.md', encoder.encode(note('bad, fixed\n')));
	folder.disk.rename('notes/Todo.md', 'notes/todo 2.md');
	await runFor(world, 2_000);
	expect(world.server.read('notes/bad.md')).toBe(note('bad, fixed\n'));
	expect(world.server.read('notes/todo 2.md')).toBe(note('twin\n'));
	expect(folder.replica.held()).toEqual([]);
});

test('a symlink is left alone like a dot path: never read, held, sent or written over', async () => {
	const { world, folder, other } = await setup();
	folder.disk.write('notes/a.md', encoder.encode(note('a\n')));
	folder.disk.symlink('notes/link.md', 'notes/a.md');
	await runFor(world, 2_000);
	expect(folder.replica.held()).toEqual([]);
	expect([...world.server.snapshot().keys()]).toEqual(['notes/a.md']);
	// A scan goes without it, and a remote file at its path never replaces it.
	folder.disk.write('notes/a.md', encoder.encode(note('a\nmore\n')));
	await runFor(world, 1_000);
	await until(world, folder.engine.scan());
	await runFor(world, 2_000);
	expect(world.server.read('notes/a.md')).toBe(note('a\nmore\n'));
	other.replica.write('notes/link.md', note('remote\n'));
	await runFor(world, 2_000);
	// Still the symlink: the memory disk reads a link as its target.
	expect(folder.disk.text('notes/link.md')).toBe('notes/a.md');
	expect(folder.replica.held()).toEqual([]);
});

test('two files whose names differ only in letters are held: the repository takes neither, and both go once one is renamed', async () => {
	const { world, folder } = await setup();
	folder.disk.write('notes/todo.md', encoder.encode(note('one\n')));
	await runFor(world, 2_000);
	folder.disk.write('notes/Todo.md', encoder.encode(note('twin\n')));
	await runFor(world, 2_000);
	expect(folder.replica.held()).toEqual([{ path: 'notes/Todo.md', reason: TWIN }]);
	// A save to either is held while both are there: the repository has one file for the name.
	folder.disk.write('notes/todo.md', encoder.encode(note('one\nedited\n')));
	await runFor(world, 2_000);
	expect(folder.replica.held()).toEqual([
		{ path: 'notes/Todo.md', reason: TWIN },
		{ path: 'notes/todo.md', reason: TWIN },
	]);
	expect(world.server.snapshot()).toEqual(new Map([['notes/todo.md', note('one\n')]]));
	expect([...folder.replica.files().keys()]).toEqual(['notes/todo.md']);
	// The person renames one.
	folder.disk.rename('notes/Todo.md', 'notes/todo 2.md');
	await runFor(world, 2_000);
	expect(folder.replica.held()).toEqual([]);
	expect(world.server.snapshot()).toEqual(
		new Map([
			['notes/todo.md', note('one\nedited\n')],
			['notes/todo 2.md', note('twin\n')],
		]),
	);
	expect(folder.disk.violations).toEqual([]);
});

test('the engine never writes a file beside one whose name differs only in letters: the folder takes main\'s spelling', async () => {
	const { world, folder, other } = await setup();
	// Ada creates Todo.md offline; bo's todo.md lands first, so main spells it todo.md.
	folder.device.setOnline(false);
	folder.disk.write('notes/Todo.md', encoder.encode(note('ada\n', 'Todo')));
	await runFor(world, 1_000);
	other.replica.write('notes/todo.md', note('bo\n', 'Todo'), { over: null });
	await runFor(world, 1_000);
	folder.device.setOnline(true);
	const both: number[] = [];
	for (const end = world.net.now() + 5_000; world.net.now() < end; ) {
		if ((await step(world)) === false) await runFor(world, 10);
		const spellings = folder.disk.paths().filter((path) => fold(path) === fold('notes/todo.md'));
		if (spellings.length > 1) both.push(world.net.now());
	}
	expect(both).toEqual([]);
	const text = world.server.read('notes/todo.md') ?? '';
	expect(text).toContain('ada');
	expect(text).toContain('bo');
	expect(folder.disk.paths()).toEqual(['notes/todo.md']);
	expect(folder.disk.text('notes/todo.md')).toBe(text);
	expect(folder.replica.held()).toEqual([]);
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

test('a file replaced by a folder of its name between two looks is a delete and the folder\'s files', async () => {
	const { world, folder } = await setup();
	folder.disk.write('album', encoder.encode('cover bytes'));
	await runFor(world, 1_000);
	await until(world, folder.upload());
	await runFor(world, 2_000);
	expect(world.server.read('album')).toContain('oid sha256:');
	folder.disk.unlink('album');
	folder.disk.write('album/a.md', encoder.encode(note('a\n')));
	await runFor(world, 2_000);
	expect(folder.replica.held()).toEqual([]);
	expect(world.server.read('album')).toBeNull();
	expect(world.server.read('album/a.md')).toBe(note('a\n'));
});

test('a file made offline where another device made a folder is held with why: the folder keeps its files, and a rename lands both', async () => {
	const { world, lfs, folder } = await setup();
	const cy = createFolderDevice(world, 'cy', { lfs });
	await until(world, cy.start());
	await runFor(world, 1_000);
	cy.device.setOnline(false);
	cy.disk.write('album', encoder.encode('cover bytes'));
	await runFor(world, 1_000);
	await until(world, cy.upload());
	folder.disk.write('album/a.md', encoder.encode(note('a\n')));
	await runFor(world, 2_000);
	expect(world.server.read('album/a.md')).toBe(note('a\n'));
	cy.device.setOnline(true);
	await runFor(world, 5_000);
	expect(cy.replica.held()).toEqual([{ path: 'album', reason: 'a folder already has this name' }]);
	expect(world.server.read('album/a.md')).toBe(note('a\n'));
	expect(world.server.read('album')).toBeNull();
	expect(folder.disk.text('album/a.md')).toBe(note('a\n'));
	expect(cy.disk.text('album')).toBe('cover bytes');
	// The person renames their file: it lands, and the folder's file reaches their disk.
	cy.disk.rename('album', 'album.png');
	await runFor(world, 5_000);
	expect(cy.replica.held()).toEqual([]);
	expect(world.server.read('album.png')).toContain('oid sha256:');
	expect(cy.disk.text('album/a.md')).toBe(note('a\n'));
	expect(folder.disk.text('album.png')).toBe('cover bytes');
	expect(folder.disk.violations).toEqual([]);
	expect(cy.disk.violations).toEqual([]);
});

/**
 * The deciding scenario (decision item 9): an agent's stopped folder sends
 * two notes and a new blob now (`sync --once`) while a person autosaves
 * overlapping lines every 2 s, the blob's upload is delayed, one note is
 * invalid at the door, and the reply is lost.
 */
async function deciding({ invalid }: { invalid: boolean }) {
	const world = createWorld({ seed: 11, latency: { min: 2, max: 20 } });
	const lfs: Lfs = new Map();
	const person = world.device('bo');
	const agent = createFolderDevice(world, 'ada', { lfs });
	person.replica.write('notes/plan.md', note('one\ntwo\nthree\n'));
	await runFor(world, 1_000);
	await until(world, agent.start({ watch: false }));
	await runFor(world, 1_000);
	agent.engine.kill();
	agent.device.setOnline(false);
	// The agent edits while no sync runs.
	await agent.crash({ watch: false });
	agent.disk.write('notes/plan.md', encoder.encode(note('one\nTWO by the agent\nthree\n')));
	agent.disk.write('notes/summary.md', invalid ? new Uint8Array([0xff, 0xfe, 0x41]) : encoder.encode(note('summary\n')));
	agent.disk.write('media/chart.png', encoder.encode('chart bytes'));
	await runFor(world, 1_000);
	await until(world, agent.engine.scan());
	// A note that is not UTF-8 is refused where it is found: held, never unsent.
	expect(agent.replica.unsent()).toEqual(invalid ? ['media/chart.png', 'notes/plan.md'] : ['media/chart.png', 'notes/plan.md', 'notes/summary.md']);
	// The person autosaves the same lines every 2 s while the agent's commit is out.
	let typed = 0;
	const autosave = () => {
		if (typed >= 5) return;
		typed++;
		person.replica.edit('notes/plan.md', (text) => (text ?? '').replace(/^(two|second, take \d+)$/m, `second, take ${typed}`));
		world.net.after(2_000, autosave);
	};
	autosave();
	agent.device.setOnline(true);
	agent.device.loseNextReply();
	await runFor(world, 3_000);
	// The upload arrives late.
	await until(world, agent.upload());
	await runFor(world, 12_000);
	return { world, agent, person };
}

test('the deciding scenario: an invalid note is held alone; the other note lands merged with the typing, the blob once uploaded, and the fixed note once', async () => {
	const { world, agent } = await deciding({ invalid: true });
	expect(agent.replica.held()).toEqual([{ path: 'notes/summary.md', reason: 'not UTF-8 text' }]);
	expect(world.server.read('notes/summary.md')).toBeNull();
	expect(world.server.read('media/chart.png')).not.toBeNull();
	const plan = world.server.read('notes/plan.md') ?? '';
	expect(plan.split('TWO by the agent').length - 1).toBe(1);
	expect(agent.replica.state('notes/plan.md')).toEqual({ status: 'synced' });
	agent.disk.write('notes/summary.md', encoder.encode(note('summary\n')));
	await runFor(world, 1_000);
	await until(world, agent.engine.scan());
	await runFor(world, 10_000);
	expect(world.server.read('notes/summary.md')).toBe(note('summary\n'));
	expect((world.server.read('notes/plan.md') ?? '').split('TWO by the agent').length - 1).toBe(1);
	expect(agent.replica.held()).toEqual([]);
});

test('the deciding scenario without the invalid note: everything lands, the agent\'s line once, its conflict block with the person in the text', async () => {
	const { world, agent } = await deciding({ invalid: false });
	const plan = world.server.read('notes/plan.md') ?? '';
	expect(plan.split('TWO by the agent').length - 1).toBe(1);
	expect(findConflicts(plan).length).toBeGreaterThanOrEqual(1);
	expect(world.server.read('notes/summary.md')).toBe(note('summary\n'));
	expect(world.server.read('media/chart.png')).not.toBeNull();
	expect(agent.replica.unsent()).toEqual([]);
});
