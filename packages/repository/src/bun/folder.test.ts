/**
 * Folder Commands Tests
 *
 * `epicenter sync` and `epicenter commit` (`folder-commands.ts`) over real
 * folders in a temporary directory and a repository served in this
 * process, through the socket, the upload track and the Bun folder port.
 *
 * Key behaviors:
 * - `sync --join` makes the folder's identity, and a save in one folder reaches another through the server
 * - `commit -m` lands every difference as one commit with its message; again with nothing new it is `unchanged`; a note the door refuses holds the whole group, exit 2, and fixing it and committing again lands it once
 * - A second engine over a folder whose replica is held (another process) is refused; a copy of a folder is refused until `--join` makes it new
 * - A folder that is not empty joining a repository that is not empty: an equal file is only recorded; a different one meets the note as a create (one conflict block)
 */
import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConflicts } from '../core/conflict.js';
import { createTestServer } from '../sim/harness.js';
import { authenticateBearer } from '../wire/wire.js';
import { commit, type Line, sync } from './folder-commands.js';
import { openFolderEngine } from './folder.js';
import { serveRepository } from './serve.js';

const roots: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const stop of stops) await stop();
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const note = (body: string) => `---\ntitle: A\n---\n${body}`;

function setup() {
	const root = mkdtempSync(join(tmpdir(), 'folder-commands-'));
	roots.push(root);
	const server = createTestServer({ clock: () => Date.now() });
	const served = serveRepository({ repository: 'home', serverId: 'local', server, authenticate: authenticateBearer((token) => ({ user: token, role: 'owner' })), port: 0 });
	stops.push(served.stop);
	const folder = (name: string) => {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	};
	const lines: Line[] = [];
	const print = (line: Line) => void lines.push(line);
	const base = { dataDir: join(root, 'data'), token: 'ada', quiet: 50 };
	return { root, server, served, folder, lines, print, base };
}

test('sync --join makes the identity, and a save in one folder reaches another through the server', async () => {
	const { server, served, folder, print, base, lines } = setup();
	const [a, b] = [folder('a'), folder('b')];
	const join_ = { repository: 'me/home', server: served.url };
	writeFileSync(join(a, 'hello.md'), note('one\n'));
	expect(await sync({ ...base, dir: a, join: join_, once: true }, print)).toBe(0);
	expect(lines[0]).toMatchObject({ joined: 'me/home' });
	expect(JSON.parse(readFileSync(join(a, '.epicenter/repository'), 'utf8'))).toMatchObject({ repository: 'me/home', server: served.url, account: 'ada' });
	expect(server.read('hello.md')).toBe(note('one\n'));
	expect(await sync({ ...base, dir: b, join: join_, once: true }, print)).toBe(0);
	expect(readFileSync(join(b, 'hello.md'), 'utf8')).toBe(note('one\n'));
	// A live folder takes a save from the other.
	let stop = () => {};
	const running = sync({ ...base, dir: b, stop: new Promise<void>((resolve) => (stop = resolve)) }, print);
	await Bun.sleep(500);
	writeFileSync(join(a, 'hello.md'), note('one\ntwo\n'));
	expect(await sync({ ...base, dir: a, once: true }, print)).toBe(0);
	for (let i = 0; i < 60 && readFileSync(join(b, 'hello.md'), 'utf8') !== note('one\ntwo\n'); i++) await Bun.sleep(100);
	expect(readFileSync(join(b, 'hello.md'), 'utf8')).toBe(note('one\ntwo\n'));
	stop();
	expect(await running).toBe(0);
}, 30_000);

test('commit lands every difference as one commit with its message; then unchanged; a refused note holds the group until fixed', async () => {
	const { server, served, folder, print, base, lines } = setup();
	const dir = folder('agent');
	expect(await sync({ ...base, dir, join: { repository: 'me/home', server: served.url }, agent: 'claude', once: true }, print)).toBe(0);
	writeFileSync(join(dir, 'a.md'), note('a\n'));
	writeFileSync(join(dir, 'b.md'), note('b\n'));
	writeFileSync(join(dir, 'c.png'), 'png bytes');
	const pushes: string[] = [];
	server.subscribe((event) => pushes.push(event.commit));
	lines.length = 0;
	expect(await commit({ ...base, dir, message: 'Three files' }, print)).toBe(0);
	expect(lines.at(-1)).toMatchObject({ landed: expect.stringMatching(/^[0-9a-f]{40}$/), conflicts: [] });
	expect(server.read('a.md')).toBe(note('a\n'));
	expect(server.read('c.png')).toContain('oid sha256:');
	expect(await commit({ ...base, dir, message: 'Again' }, print)).toBe(0);
	expect(lines.at(-1)).toEqual({ unchanged: true });
	// One note the door refuses: nothing lands, the group and its message wait.
	writeFileSync(join(dir, 'a.md'), note('a\nmore\n'));
	writeFileSync(join(dir, 'bad.md'), '---\ntitle: [\n---\n');
	expect(await commit({ ...base, dir, message: 'Broken', wait: 3_000 }, print)).toBe(2);
	expect(lines.at(-1)).toMatchObject({ held: [{ path: 'bad.md', reason: expect.any(String) }] });
	expect(server.read('a.md')).toBe(note('a\n'));
	writeFileSync(join(dir, 'bad.md'), note('fixed\n'));
	expect(await commit({ ...base, dir, message: 'Fixed' }, print)).toBe(0);
	expect(server.read('a.md')).toBe(note('a\nmore\n'));
	expect(server.read('bad.md')).toBe(note('fixed\n'));
}, 30_000);

test('commit reports its own call only: a file held from an earlier call neither stops it nor is named in its verdict', async () => {
	const { server, served, folder, print, base, lines } = setup();
	const dir = folder('agent');
	expect(await sync({ ...base, dir, join: { repository: 'me/home', server: served.url }, agent: 'claude', once: true }, print)).toBe(0);
	writeFileSync(join(dir, 'old.md'), '---\ntitle: [\n---\n');
	expect(await commit({ ...base, dir, message: 'Old', wait: 3_000 }, print)).toBe(2);
	expect(lines.at(-1)).toEqual({ held: [{ path: 'old.md', reason: expect.any(String) }] });
	// A new call lands although old.md is still held.
	writeFileSync(join(dir, 'good.md'), note('good\n'));
	lines.length = 0;
	expect(await commit({ ...base, dir, message: 'Good' }, print)).toBe(0);
	expect(lines.at(-1)).toMatchObject({ landed: expect.stringMatching(/^[0-9a-f]{40}$/), conflicts: [] });
	expect(server.read('good.md')).toBe(note('good\n'));
	// A new call held on its own file names that file, not old.md.
	writeFileSync(join(dir, 'new.md'), '---\ntitle: ]\n---\n');
	writeFileSync(join(dir, 'good.md'), note('good\nbetter\n'));
	lines.length = 0;
	expect(await commit({ ...base, dir, message: 'New', wait: 3_000 }, print)).toBe(2);
	expect(lines.at(-1)).toEqual({ held: [{ path: 'new.md', reason: expect.any(String) }] });
	expect(server.read('good.md')).toBe(note('good\n'));
}, 30_000);

test('commit with nothing new reports the real outcome of a commit an earlier run left unsent', async () => {
	const { server, served, folder, print, base, lines } = setup();
	const dir = folder('agent');
	expect(await sync({ ...base, dir, join: { repository: 'me/home', server: served.url }, agent: 'claude', once: true }, print)).toBe(0);
	// An earlier run saved its call and stopped before it connected.
	writeFileSync(join(dir, 'a.md'), note('a\n'));
	const opened = await openFolderEngine({ ...base, dir });
	if (opened.error !== null) throw new Error(opened.error.message);
	await opened.data.engine.commit('Earlier');
	await opened.data.engine.stop();
	opened.data.close();
	const landedHere: string[] = [];
	server.subscribe((event) => landedHere.push(event.commit));
	lines.length = 0;
	expect(await commit({ ...base, dir, message: 'Nothing new' }, print)).toBe(0);
	expect(server.read('a.md')).toBe(note('a\n'));
	// The earlier call's own commit, which landed on this run (main had not moved, so it became main).
	expect(lines.at(-1)).toEqual({ landed: landedHere[0] ?? 'none', conflicts: [], kept: [] });
}, 30_000);

test('a second engine over a held replica is refused, and a copy is refused until --join makes it new', async () => {
	const { served, folder, print, base, lines, root } = setup();
	const dir = folder('home');
	expect(await sync({ ...base, dir, join: { repository: 'me/home', server: served.url }, once: true }, print)).toBe(0);
	// Another process holds the replica.
	const holder = Bun.spawn(['bun', '-e', `const { openFolderEngine } = await import(${JSON.stringify(join(import.meta.dir, 'folder.ts'))}); const o = await openFolderEngine({ dir: ${JSON.stringify(dir)}, dataDir: ${JSON.stringify(base.dataDir)}, token: 'ada' }); if (o.error) { console.log('ERR', o.error.message); process.exit(1); } console.log('HELD'); await Bun.sleep(4000);`], { stdout: 'pipe' });
	const reader = holder.stdout.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	expect(first).toContain('HELD');
	lines.length = 0;
	expect(await commit({ ...base, dir, message: 'x' }, print)).toBe(1);
	expect(lines.at(-1)).toMatchObject({ error: expect.stringContaining('is kept by another engine (a running epicenter sync, or another commit)') });
	holder.kill();
	await holder.exited;
	// A crash releases it.
	expect(await commit({ ...base, dir, message: 'x' }, print)).toBe(0);
	const copy = join(root, 'copy');
	cpSync(dir, copy, { recursive: true });
	lines.length = 0;
	expect(await sync({ ...base, dir: copy, once: true }, print)).toBe(1);
	expect(lines.at(-1)).toMatchObject({ error: expect.stringContaining('this folder is a copy of') });
	expect(await sync({ ...base, dir: copy, join: { repository: 'me/home', server: served.url }, once: true }, print)).toBe(0);
}, 30_000);

test('a folder that is not empty joins a repository that is not empty: an equal file is recorded, a different one meets the note', async () => {
	const { server, served, folder, print, base } = setup();
	const first = folder('first');
	writeFileSync(join(first, 'same.md'), note('same\n'));
	writeFileSync(join(first, 'differs.md'), note('theirs\n'));
	expect(await sync({ ...base, dir: first, join: { repository: 'me/home', server: served.url }, once: true }, print)).toBe(0);
	const second = folder('second');
	writeFileSync(join(second, 'same.md'), note('same\n'));
	writeFileSync(join(second, 'differs.md'), note('mine\n'));
	expect(await sync({ ...base, dir: second, join: { repository: 'me/home', server: served.url }, once: true }, print)).toBe(0);
	expect(server.read('same.md')).toBe(note('same\n'));
	const merged = server.read('differs.md') ?? '';
	expect(merged).toContain('theirs');
	expect(merged).toContain('mine');
	expect(findConflicts(merged)).toHaveLength(1);
	expect(readFileSync(join(second, 'differs.md'), 'utf8')).toBe(merged);
}, 30_000);
