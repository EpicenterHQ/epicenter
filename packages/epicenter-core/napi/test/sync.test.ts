/**
 * The sync core loaded in Bun through Node-API, syncing over HTTP against a
 * `Bun.serve` remote in this same process (stock `git http-backend` and an
 * LFS batch server, both behind a bearer token), with the real `settle`
 * from `@epicenter/definition` as the note merge. The spike's synchronous
 * binding deadlocked here: it blocked the thread the server answers on.
 *
 * Run `bun packages/epicenter-core/napi/build.ts` first, or the suite
 * builds a debug addon itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPOSITORY_ATTRIBUTES } from '../../../definition/src/contract/storage.ts';
import {
	findConflicts,
	parsePointer,
} from '../../../definition/src/merge/index.ts';
import { startRemote, type TestRemote } from './remote.test-support.ts';

const HERE = join(import.meta.dir, '..');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-core-bun-')));
const TOKEN = 'test-token-1234';
const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

let core: typeof import('../index.ts');
let remote: TestRemote;
let url: string;
const settled: string[] = [];

const write = (folder: string, path: string, text: string | Uint8Array) => {
	mkdirSync(dirname(join(folder, path)), { recursive: true });
	writeFileSync(join(folder, path), text);
};
const read = (folder: string, path: string) =>
	readFileSync(join(folder, path), 'utf8');
const git = (cwd: string, ...args: string[]) => {
	const ran = Bun.spawnSync(['git', ...args], {
		cwd,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_NOSYSTEM: '1',
		},
	});
	return { code: ran.exitCode, out: ran.stdout.toString().trim() };
};

function sync(folder: string, machine: string, token: string | null = TOKEN) {
	return core.addon.sync(
		folder,
		{ machine, remote: { url, ...(token === null ? {} : { token }) } },
		(input) => {
			settled.push(
				`${input.path} base=${input.base === undefined ? 'none' : 'yes'}`,
			);
			return core.settleNote(input);
		},
	);
}

beforeAll(async () => {
	if (!existsSync(join(HERE, 'epicenter_core.node'))) {
		const built = Bun.spawnSync(['bun', join(HERE, 'build.ts'), '--debug'], {
			stdout: 'inherit',
			stderr: 'inherit',
		});
		if (built.exitCode !== 0) throw new Error('the addon did not build');
	}
	core = await import('../index.ts');
	const root = join(BOX, 'remote');
	Bun.spawnSync([
		'git',
		'init',
		'-q',
		'--bare',
		'-b',
		'main',
		join(root, 'whispering.git'),
	]);
	remote = startRemote(root, TOKEN);
	url = `${remote.url}/whispering.git`;
});

afterAll(() => remote?.stop());

describe('the sync core under Bun', () => {
	const a = join(BOX, 'a');
	const b = join(BOX, 'b');

	test('loads, and names the libgit2 it links', () => {
		expect(core.addon.libgit2Version()).toMatch(/^1\.\d+\.\d+$/);
	});

	test('a round runs off the JavaScript thread, answered by a server on it', async () => {
		write(a, '.gitattributes', REPOSITORY_ATTRIBUTES);
		write(
			a,
			'recordings/one.md',
			'---\ntitle: One\ntags: work\n---\nfirst line\nsecond line\n',
		);
		write(a, 'recordings/one.wav', WAV);
		let ticks = 0;
		const timer = setInterval(() => ticks++, 1);
		const round = await sync(a, 'Mac A');
		clearInterval(timer);
		expect(round.status).toBe('synced');
		expect(ticks).toBeGreaterThan(0);
		const remoteGit = join(BOX, 'remote', 'whispering.git');
		const pointer = parsePointer(
			`${git(remoteGit, 'cat-file', 'blob', 'main:recordings/one.wav').out}\n`,
		);
		expect(pointer?.size).toBe(8);
		expect(existsSync(join(remote.objects, pointer?.oid ?? ''))).toBe(true);
		expect(git(remoteGit, 'log', '-1', '--format=%s', 'main').out).toBe(
			'Added from Mac A',
		);
	});

	test('first contact on a second machine settles a shared note with the real settle', async () => {
		write(b, '.gitattributes', REPOSITORY_ATTRIBUTES);
		write(b, 'recordings/one.md', '---\ntitle: One from B\n---\nmade on b\n');
		write(b, 'recordings/two.md', '---\ntitle: Two\n---\nonly on b\n');
		const round = await sync(b, 'Mac B');
		expect(round.status).toBe('synced');
		expect(settled).toContain('recordings/one.md base=none');
		expect(new Uint8Array(readFileSync(join(b, 'recordings/one.wav')))).toEqual(
			WAV,
		);
		expect(git(b, 'log', '--format=%s', 'main').out.split('\n')).toEqual([
			'Added from Mac B',
			'Added from Mac A',
		]);
		const one = read(b, 'recordings/one.md');
		expect(one.startsWith('---\ntitle: One\ntags: work\n---\n')).toBe(true);
		expect(findConflicts(one)).toHaveLength(1);
	});

	test('a three-way merge settles front matter by key and the body by line', async () => {
		expect((await sync(a, 'Mac A')).status).toBe('synced');
		const base = read(a, 'recordings/one.md');
		expect(read(b, 'recordings/one.md')).toBe(base);
		write(
			a,
			'recordings/one.md',
			base
				.replace('title: One', 'title: Renamed on A')
				.replace('first line', 'first line, edited on A'),
		);
		expect((await sync(a, 'Mac A')).status).toBe('synced');
		write(
			b,
			'recordings/one.md',
			base
				.replace('title: One', 'title: Renamed on B')
				.replace('tags: work', 'tags: home')
				.replace('first line', 'first line, edited on B'),
		);
		settled.length = 0;
		const round = await sync(b, 'Mac B');
		expect(round.status).toBe('synced');
		expect(settled).toEqual(['recordings/one.md base=yes']);
		const merged = read(b, 'recordings/one.md');
		expect(merged).toContain('title: Renamed on B');
		expect(merged).toContain('tags: home');
		expect(findConflicts(merged).length).toBeGreaterThanOrEqual(1);
		expect((await sync(a, 'Mac A')).status).toBe('synced');
		expect(read(a, 'recordings/one.md')).toBe(merged);
	});

	test('two rounds on one folder at once take turns', async () => {
		write(a, 'recordings/three.md', '---\ntitle: Three\n---\nthree\n');
		const rounds = await Promise.all([sync(a, 'Mac A'), sync(a, 'Mac A')]);
		expect(rounds.map((r) => r.status)).toEqual(['synced', 'synced']);
		expect(
			git(
				join(BOX, 'remote', 'whispering.git'),
				'show',
				'main:recordings/three.md',
			).out,
		).toBe('---\ntitle: Three\n---\nthree');
	});

	test('a settle that throws stops the round and names why', async () => {
		write(a, 'recordings/one.md', `${read(a, 'recordings/one.md')}a\n`);
		expect((await sync(a, 'Mac A')).status).toBe('synced');
		write(b, 'recordings/one.md', `${read(b, 'recordings/one.md')}b\n`);
		const round = await core.addon.sync(
			b,
			{ machine: 'Mac B', remote: { url, token: TOKEN } },
			() => {
				throw new Error('settle broke');
			},
		);
		expect(round.status).toBe('stopped');
		expect(round.message).toContain('settle broke');
		expect((await sync(b, 'Mac B')).status).toBe('synced');
	});

	test('every request carried the bearer token, and none is stored in Git config', () => {
		expect(remote.requests.length).toBeGreaterThan(0);
		expect(remote.requests.filter((r) => !r.authorized)).toEqual([]);
		for (const folder of [a, b])
			expect(
				readFileSync(join(folder, '.git', 'config'), 'utf8'),
			).not.toContain(TOKEN);
	});

	test('without the token the round stops and changes nothing', async () => {
		const head = git(a, 'rev-parse', 'HEAD').out;
		const before = remote.requests.length;
		const round = await sync(a, 'Mac A', null);
		expect(remote.requests.slice(before).every((r) => !r.authorized)).toBe(
			true,
		);
		expect(round.status).toBe('stopped');
		expect(round.message).toContain('403');
		expect(git(a, 'rev-parse', 'HEAD').out).toBe(head);
	});

	test('stock git sees clean folders with whole history', async () => {
		expect((await sync(a, 'Mac A')).status).toBe('synced');
		expect((await sync(b, 'Mac B')).status).toBe('synced');
		for (const folder of [a, b]) {
			expect(git(folder, 'status', '--porcelain')).toEqual({
				code: 0,
				out: '',
			});
			expect(git(folder, 'fsck', '--no-progress').code).toBe(0);
		}
	});
});
