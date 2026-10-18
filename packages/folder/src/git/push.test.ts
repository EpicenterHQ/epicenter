/**
 * A browser push (`push.ts`) sends every object the remote lacks: histories
 * built with system Git are fetched into a browser folder from one bare
 * repository and pushed to another that holds some of them, served by
 * `git http-backend`, and the receiving repository must pass
 * `git fsck --strict`.
 *
 * Key behaviors:
 * - A tree a later commit shares with an earlier one is sent whole, even
 *   when the later commit's own parent held part of it
 * - Random histories with merges, moves, copied directories, reverts, and
 *   clocks that run backwards push complete
 * - A protocol version 2 advertisement, or a line that names no ref, is
 *   refused rather than read as a remote with no branch
 * - A remote URL that carries a username or password is refused
 */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type * as git from 'isomorphic-git';
import { rawBrowserFolder } from '../browser-storage.test-support.js';
import {
	createBareRemote,
	GIT_ENV,
	gitHttpFetch,
	git as nativeGit,
	scratch,
} from '../git-http.test-support.js';
import { pushRef } from './push.js';

/** System Git in `cwd` with extra environment, such as a commit date. */
async function run(
	cwd: string,
	env: Record<string, string>,
	...args: string[]
): Promise<string> {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: { ...GIT_ENV, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
	return stdout.trim();
}

/**
 * Fetch `head` from `source.git` under `root` into a new browser folder, then
 * push it to `remote.git` there, which must accept it complete.
 */
async function pushThrough(root: string, id: string, head: string) {
	const raw = await rawBrowserFolder({ id });
	const backend = await raw.backend({
		remote: { url: 'http://git.test/source.git', branch: 'main' },
		httpFetch: await gitHttpFetch(root),
	});
	const signal = new AbortController().signal;
	expect(await backend.fetch(signal)).toBe(head);
	await backend.setRemote('http://git.test/remote.git');
	expect(await backend.push(head, signal)).toBe('pushed');
	const remote = join(root, 'remote.git');
	await run(remote, {}, 'fsck', '--strict', '--no-dangling');
	expect(await run(remote, {}, 'rev-parse', 'main')).toBe(head);
}

test('a tree a later commit shares with an earlier one is sent whole', async () => {
	const root = await scratch('folder-push-shared-tree-');
	try {
		const work = join(root, 'work');
		await nativeGit(root, 'init', '-q', '--initial-branch=main', work);
		await writeFile(join(work, 'top'), 'x\n');
		await nativeGit(work, 'add', '-A');
		await nativeGit(work, 'commit', '-qm', 'M0');
		const remote = await createBareRemote(root);
		await nativeGit(work, 'push', '-q', remote, 'main');
		// A adds w/v/f and w/a; B edits w/a; H restores it, so H's `w` is A's.
		await mkdir(join(work, 'w/v'), { recursive: true });
		await writeFile(join(work, 'w/v/f'), 'f\n');
		await writeFile(join(work, 'w/a'), '1\n');
		await nativeGit(work, 'add', '-A');
		await nativeGit(work, 'commit', '-qm', 'A');
		await writeFile(join(work, 'w/a'), '2\n');
		await nativeGit(work, 'commit', '-qam', 'B');
		await writeFile(join(work, 'w/a'), '1\n');
		await nativeGit(work, 'commit', '-qam', 'H');
		const source = join(root, 'source.git');
		await nativeGit(
			root,
			'init',
			'-q',
			'--bare',
			'--initial-branch=main',
			source,
		);
		await nativeGit(work, 'push', '-q', source, 'main');
		await pushThrough(
			root,
			'shared-tree',
			await nativeGit(work, 'rev-parse', 'HEAD'),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);

function random(seed: number) {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 4294967296;
	};
}

async function listFiles(directory: string, base = ''): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(join(directory, base), {
		withFileTypes: true,
	})) {
		if (entry.name === '.git') continue;
		const path = base ? `${base}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...(await listFiles(directory, path)));
		else files.push(path);
	}
	return files;
}

/**
 * A random history in `work`, from `seed`: commits on random parents, some
 * merges, each adding, removing, moving, copying, and restoring paths, with
 * a clock that sometimes runs backwards. Returns the commits, last the head.
 */
async function randomHistory(work: string, next: () => number) {
	const pick = <T>(items: readonly T[]) =>
		items[Math.floor(next() * items.length)] as T;
	const commits: string[] = [];
	const contents = ['a\n', 'b\n', 'c\n', 'd\n', 'e\n', 'f\n'];
	const dirs = ['x', 'x/y', 'x/y/z', 'w', 'w/v'];
	let time = 1_700_000_000;
	const count = 8 + Math.floor(next() * 25);
	for (let index = 0; index < count; index++) {
		const parents: string[] = [];
		if (commits.length > 0) {
			parents.push(pick(commits));
			if (commits.length > 1 && next() < 0.35) {
				const second = pick(commits);
				if (second !== parents[0]) parents.push(second);
			}
		}
		if (parents[0])
			await run(work, {}, 'read-tree', '-u', '--reset', parents[0]);
		else await run(work, {}, 'rm', '-rqf', '--ignore-unmatch', '.');
		const edits = 1 + Math.floor(next() * 4);
		for (let edit = 0; edit < edits; edit++) {
			const files = await listFiles(work);
			const kind = next();
			if (kind < 0.35 || files.length === 0) {
				const path = `${pick(dirs)}/f${Math.floor(next() * 6)}`;
				await mkdir(join(work, dirname(path)), { recursive: true });
				await writeFile(join(work, path), pick(contents));
			} else if (kind < 0.5) {
				await rm(join(work, pick(files)));
			} else if (kind < 0.62) {
				const from = pick(files);
				const to = `${pick(dirs)}/m${Math.floor(next() * 6)}`;
				if (!existsSync(join(work, to))) {
					await mkdir(join(work, dirname(to)), { recursive: true });
					await rename(join(work, from), join(work, to));
				}
			} else if (kind < 0.72) {
				const from = pick(dirs);
				const to = pick(['c1', 'c2', 'x/c3', 'w/v/c4']);
				if (existsSync(join(work, from)) && !to.startsWith(`${from}/`)) {
					await rm(join(work, to), { recursive: true, force: true });
					await mkdir(dirname(join(work, to)), { recursive: true });
					await cp(join(work, from), join(work, to), { recursive: true });
				}
			} else if (kind < 0.86 && commits.length > 0) {
				const old = pick(commits);
				const path = pick([...dirs, 'c1', 'c2']);
				await run(work, {}, 'checkout', old, '--', path).catch(() => {});
			} else if (parents[1]) {
				const path = pick(dirs);
				await run(work, {}, 'checkout', parents[1], '--', path).catch(() => {});
			} else {
				await rm(join(work, pick(dirs)), { recursive: true, force: true });
			}
		}
		await run(work, {}, 'add', '-A');
		const tree = await run(work, {}, 'write-tree');
		time +=
			next() < 0.25 ? -Math.floor(next() * 100000) : Math.floor(next() * 1000);
		const date = `${time} +0000`;
		commits.push(
			await run(
				work,
				{ GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
				'commit-tree',
				tree,
				...parents.flatMap((parent) => ['-p', parent]),
				'-m',
				`c${index}`,
			),
		);
	}
	return { commits, pick };
}

// 229 and 238 once found a tree marked sent with part of it missing.
const SEEDS = [1, 2, 3, 5, 229, 238];

test('random histories push complete', async () => {
	for (const seed of SEEDS) {
		const next = random(seed * 7919);
		const root = await scratch('folder-push-random-');
		try {
			const work = join(root, 'work');
			await run(root, {}, 'init', '-q', '--initial-branch=main', work);
			const { commits, pick } = await randomHistory(work, next);
			const head = commits.at(-1) ?? '';
			const ancestors = (await run(work, {}, 'rev-list', head)).split('\n');
			const source = join(root, 'source.git');
			await run(
				root,
				{},
				'init',
				'-q',
				'--bare',
				'--initial-branch=main',
				source,
			);
			await run(work, {}, 'push', '-q', source, `${head}:refs/heads/main`);
			// The remote holds a random ancestor, or nothing, and other branches.
			const remote = await createBareRemote(root);
			const base = next() < 0.15 ? undefined : pick(ancestors);
			if (base !== undefined)
				await run(work, {}, 'push', '-q', remote, `${base}:refs/heads/main`);
			const extra = Math.floor(next() * 3);
			for (let branch = 0; branch < extra; branch++)
				await run(
					work,
					{},
					'push',
					'-q',
					'-f',
					remote,
					`${pick(commits)}:refs/heads/b${branch}`,
				);
			await pushThrough(root, `random-${seed}`, head);
		} catch (cause) {
			throw new Error(`seed ${seed}: ${(cause as Error).message}`);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}, 120_000);

const pkt = (line: string) =>
	`${(new TextEncoder().encode(line).byteLength + 4).toString(16).padStart(4, '0')}${line}`;

/** A client whose every request is answered with `body`. */
const answering = (body: string): git.HttpClient => ({
	async request({ url, method = 'GET' }) {
		return {
			url,
			method,
			statusCode: 200,
			statusMessage: 'OK',
			headers: {},
			body: (async function* () {
				yield new TextEncoder().encode(body);
			})(),
		};
	},
});

const push = (body: string) =>
	pushRef({
		access: { fs: {} as git.PromiseFsClient, gitdir: '/git' },
		http: answering(body),
		url: 'http://example.test/r.git',
		headers: {},
		ref: 'refs/heads/main',
		oid: 'a'.repeat(40),
	});

test('an advertisement a push cannot read is refused, not read as no branch', async () => {
	const service = `${pkt('# service=git-receive-pack\n')}0000`;
	await expect(
		push(`${service}${pkt('version 2\n')}${pkt('agent=x\n')}0000`),
	).rejects.toThrow('protocol version 2');
	await expect(
		push(
			`${service}${pkt(`${'b'.repeat(40)} refs/heads/main\0report-status\n`)}${pkt('not a ref\n')}0000`,
		),
	).rejects.toThrow('names no ref: not a ref');
});

test('a remote URL with a username or password is refused', async () => {
	const raw = await rawBrowserFolder({ id: 'credential-url' });
	const backend = await raw.backend();
	for (const url of [
		'https://me:token@example.test/r.git',
		'https://token@example.test/r.git',
	])
		await expect(backend.setRemote(url)).rejects.toThrow(
			'may not contain a username or password',
		);
	expect(backend.remote).toBeUndefined();
	await backend.setRemote('https://example.test/r.git?ref=a@b');
	expect(backend.remote?.url).toBe('https://example.test/r.git?ref=a@b');
});
