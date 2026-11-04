/**
 * The sync core loaded in Bun through Node-API, syncing over HTTP (stock
 * `git http-backend` and an LFS batch server, both behind a bearer token),
 * with `settle` from `@epicenter/definition` as the note merge.
 *
 * Run `bun packages/sync-core/build-addon.ts` first, or the suite builds a
 * debug addon itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findConflicts, parsePointer } from '../../definition/src/merge/index.ts';
import { spawnRemote, type TestRemote } from './remote.test-support.ts';

const ROOT = join(import.meta.dir, '..');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'sync-core-bun-')));
const TOKEN = 'test-token-1234';
const ATTRIBUTES = `# BEGIN epicenter (managed by Epicenter; edit outside this block)
# Notes merge by Epicenter's rules; every other file except hidden paths is Git LFS.
* filter=lfs diff=lfs merge=lfs -text
*.[mM][dD] !filter !diff merge=epicenter text
.* !filter !diff !merge !text
.*/** !filter !diff !merge !text
**/.*/** !filter !diff !merge !text
# END epicenter
`;

let core: typeof import('../index.ts');
let remote: TestRemote;
let url: string;
const settled: string[] = [];

const write = (folder: string, path: string, text: string | Uint8Array) => {
	mkdirSync(dirname(join(folder, path)), { recursive: true });
	writeFileSync(join(folder, path), text);
};
const read = (folder: string, path: string) => readFileSync(join(folder, path), 'utf8');
const git = (cwd: string, ...args: string[]) =>
	Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).stdout.toString().trim();

function sync(folder: string, machine: string, token: string | null = TOKEN) {
	const round = core.addon.syncRound(folder, { machine, remote: { url, ...(token === null ? {} : { token }) } }, (input) => {
		settled.push(`${input.path} base=${input.base === undefined ? 'none' : 'yes'}`);
		return core.settleNote(input);
	});
	console.log(`${machine}: ${round.status} ${round.message ?? ''} ${round.notes.join('; ')}`);
	return round;
}

beforeAll(async () => {
	if (!existsSync(join(ROOT, 'sync_core.node'))) {
		const built = Bun.spawnSync(['bun', join(ROOT, 'build-addon.ts'), '--debug'], { stdout: 'inherit', stderr: 'inherit' });
		if (built.exitCode !== 0) throw new Error('the addon did not build');
	}
	core = await import('../index.ts');
	Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', join(BOX, 'remote', 'whispering.git')]);
	remote = await spawnRemote(join(BOX, 'remote'), TOKEN);
	url = `${remote.url}/whispering.git`;
});

afterAll(() => remote?.stop());

describe('the sync core under Bun', () => {
	test('loads, and names the libgit2 it links', () => {
		expect(core.addon.libgit2Version()).toMatch(/^1\.\d+\.\d+$/);
	});

	const a = join(BOX, 'a');
	const b = join(BOX, 'b');

	test('a first round pushes notes as text and other files as LFS pointers', () => {
		write(a, '.gitattributes', ATTRIBUTES);
		write(a, 'recordings/one.md', '---\ntitle: One\ntags: work\n---\nfirst line\nsecond line\n');
		write(a, 'recordings/one.wav', new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]));
		const round = sync(a, 'Mac A');
		expect(round.status).toBe('synced');
		const remoteGit = join(BOX, 'remote', 'whispering.git');
		const pointer = git(remoteGit, 'cat-file', 'blob', 'main:recordings/one.wav');
		const parsed = parsePointer(`${pointer}\n`);
		expect(parsed?.size).toBe(8);
		expect(existsSync(join(remote.objects, parsed?.oid ?? ''))).toBe(true);
		expect(git(remoteGit, 'log', '-1', '--format=%s', 'main')).toBe('Added from Mac A');
	});

	test('first contact on a second machine: one commit on the remote main, a shared note settled', () => {
		write(b, '.gitattributes', ATTRIBUTES);
		write(b, 'recordings/one.md', '---\ntitle: One from B\n---\nmade on b\n');
		write(b, 'recordings/two.md', '---\ntitle: Two\n---\nonly on b\n');
		const round = sync(b, 'Mac B');
		expect(round.status).toBe('synced');
		expect(settled).toContain('recordings/one.md base=none');
		expect(readFileSync(join(b, 'recordings/one.wav'))).toEqual(Buffer.from([82, 73, 70, 70, 1, 2, 3, 4]));
		expect(git(b, 'log', '--format=%s', 'main').split('\n')).toEqual(['Added from Mac B', 'Added from Mac A']);
		// settle's rule for two creates: current stays, incoming lands whole as one block.
		const one = read(b, 'recordings/one.md');
		expect(one.startsWith('---\ntitle: One\ntags: work\n---\n')).toBe(true);
		expect(findConflicts(one)).toHaveLength(1);
	});

	test('a three-way merge settles front matter by key and the body by line', () => {
		expect(sync(a, 'Mac A').status).toBe('synced');
		const base = read(a, 'recordings/one.md');
		expect(read(b, 'recordings/one.md')).toBe(base);
		write(a, 'recordings/one.md', base.replace('title: One', 'title: Renamed on A').replace('first line', 'first line, edited on A'));
		expect(sync(a, 'Mac A').status).toBe('synced');
		write(b, 'recordings/one.md', base.replace('title: One', 'title: Renamed on B').replace('tags: work', 'tags: home').replace('first line', 'first line, edited on B'));
		settled.length = 0;
		const round = sync(b, 'Mac B');
		expect(round.status).toBe('synced');
		expect(settled).toEqual(['recordings/one.md base=yes']);
		const merged = read(b, 'recordings/one.md');
		// B arrives later: its title wins with no block; the bodies clash in one block.
		expect(merged).toContain('title: Renamed on B');
		expect(merged).toContain('tags: home');
		expect(findConflicts(merged).length).toBeGreaterThanOrEqual(1);
		expect(sync(a, 'Mac A').status).toBe('synced');
		expect(read(a, 'recordings/one.md')).toBe(merged);
	});

	test('every request carried the bearer token, and none is stored in Git config', () => {
		expect(remote.requests.length).toBeGreaterThan(0);
		expect(remote.requests.filter((r) => !r.authorized)).toEqual([]);
		for (const folder of [a, b]) expect(readFileSync(join(folder, '.git', 'config'), 'utf8')).not.toContain(TOKEN);
	});

	test('without the token the round stops and changes nothing', () => {
		const head = git(a, 'rev-parse', 'HEAD');
		const before = remote.requests.length;
		const round = sync(a, 'Mac A', null);
		expect(remote.requests.slice(before).every((r) => !r.authorized)).toBe(true);
		expect(round.status).not.toBe('synced');
		expect(round.message).toContain('403');
		expect(git(a, 'rev-parse', 'HEAD')).toBe(head);
	});
});
