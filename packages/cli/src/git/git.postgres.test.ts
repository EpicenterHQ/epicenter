/**
 * History leaves and enters Epicenter as Git (ADR-0824, ADR-0826), end to
 * end: a real server on a disposable Postgres cluster, a folder written
 * through its routes, and the system `git` (with Git LFS) reading and
 * writing repositories in a scratch directory. Requires initdb, pg_ctl,
 * git, and git-lfs on PATH; never connects to a configured database.
 *
 * Key behaviors:
 * - An export passes `git fsck`, and checking out each change gives the
 *   folder as it was then (projection v2): notes and `epicenter.json` as
 *   blobs, every other file as an LFS pointer whose object is in
 *   `.git/lfs/objects`, each mark a tag
 * - An export run again writes only the new changes, and a fresh export
 *   makes the same commit ids; a purged version keeps its pointer; an
 *   export in an older projection is never continued
 * - An import replays the first-parent history with each commit's author,
 *   time, and message, fetches LFS objects, turns tags into marks, writes
 *   a real directory recorded as synced, and never writes the source; an
 *   export of it gives back the same files in the same order
 * - Handing over moves the original aside with its `.git`, and leaves a
 *   link pointing into the Epicenter folder
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicenterRoot } from '@epicenter/folder/node';
import { identify } from '@epicenter/folder/platform';
import { folderRepository, makeFolder } from '@epicenter/folder/sync';
import { expectOk } from 'wellcrafted/testing';
import { purgeBlobs } from '../../../server/src/log/blobs.js';
import { startRepositoryServer } from '../../../server/src/test-helpers/repository-server.js';
import { exportGit, messageOf } from './export.ts';
import { importGit } from './import.ts';
import { git, gitText, lfsObjectPath, readLfsPointer } from './run.ts';

let server: Awaited<ReturnType<typeof startRepositoryServer>>;
let scratch: string;
const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);
const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), 'epicenter-git-'));
	// Every `git` here, the code under test's included, reads this config alone.
	const config = join(scratch, 'gitconfig');
	await writeFile(
		config,
		[
			'[user]',
			'\tname = Test',
			'\temail = test@example.test',
			'[init]',
			'\tdefaultBranch = main',
			'[filter "lfs"]',
			'\tclean = git-lfs clean -- %f',
			'\tsmudge = git-lfs smudge -- %f',
			'\tprocess = git-lfs filter-process',
			'\trequired = true',
			'',
		].join('\n'),
	);
	process.env.GIT_CONFIG_GLOBAL = config;
	process.env.GIT_CONFIG_NOSYSTEM = '1';
	process.env.HOME = scratch;
	server = await startRepositoryServer();
}, 120_000);

afterAll(async () => {
	await server?.stop();
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** Each file a commit's tree holds, by path: its bytes as Git stores them. */
async function treeOf(dir: string, commit: string) {
	const listed = await gitText(['ls-tree', '-r', '-z', commit], { cwd: dir });
	const out = new Map<string, Uint8Array>();
	for (const entry of listed.split('\0').filter(Boolean)) {
		const [meta = '', path = ''] = entry.split('\t');
		const id = meta.split(' ')[2] as string;
		const run = await git(['cat-file', 'blob', id], { cwd: dir });
		out.set(path, run.stdout);
	}
	return out;
}

/** The first-parent commits of `main` in `dir`, oldest first. */
const commitsOf = async (dir: string) =>
	(
		await gitText(['rev-list', '--first-parent', '--reverse', 'main'], {
			cwd: dir,
		})
	)
		.split('\n')
		.filter(Boolean);

test('an export passes fsck, checks out each change as it was, runs again incrementally, and is deterministic', async () => {
	const account = await server.signIn('exporter');
	const folder = expectOk(await makeFolder(account));
	const repository = folderRepository(account, folder);
	const audio = crypto.getRandomValues(new Uint8Array(40_000));
	const version = (bytes: Uint8Array) => sha256(bytes) as never;
	const commit = async (
		writes: { path: string; bytes: Uint8Array | null }[],
	) => {
		const held = expectOk(
			await repository.filesAt({ paths: writes.map(({ path }) => path) }),
		);
		const now = new Map(held.files.map(({ path, version }) => [path, version]));
		const landed = expectOk(
			await repository.commit(
				writes.map(({ path, bytes }) => ({
					path,
					bytes,
					expect: now.get(path) ?? null,
				})),
			),
		);
		expect('cursor' in landed).toBe(true);
	};
	await commit([
		{ path: 'epicenter.json', bytes: text('{"title":"Takes"}\n') },
		{ path: 'notes/a.md', bytes: text('---\ntitle: A\n---\none\n') },
		{ path: 'audio/take.webm', bytes: audio },
	]);
	expect('mark' in expectOk(await repository.mark('v1'))).toBe(true);
	await commit([
		{ path: 'notes/a.md', bytes: text('---\ntitle: A\n---\ntwo\n') },
		{ path: 'notes/say "hi" there.md', bytes: text('quoted\n') },
	]);
	await commit([
		{ path: 'audio/take.webm', bytes: null },
		{ path: 'notes/b.md', bytes: text('b\n') },
	]);

	const a = join(scratch, 'export-a');
	const first = await exportGit({ folder, history: repository, dir: a });
	expect(first).toMatchObject({
		from: 0,
		to: 3,
		tags: ['v1'],
		purged: [],
		checkout: 'made',
	});
	const fsck = await git(['fsck', '--strict'], { cwd: a });
	expect(fsck.code, fsck.stderr).toBe(0);
	const commits = await commitsOf(a);
	expect(commits).toHaveLength(3);
	expect((await gitText(['rev-parse', 'v1'], { cwd: a })).trim()).toBe(
		commits[0] as string,
	);

	// Each change, checked out, is the folder as it was then.
	for (const [index, id] of commits.entries()) {
		const seq = index + 1;
		const tree = await treeOf(a, id);
		expect(new TextDecoder().decode(tree.get('.gitattributes'))).toContain(
			'filter=lfs',
		);
		tree.delete('.gitattributes');
		const then = expectOk(await repository.filesAt({ at: seq }));
		expect([...tree.keys()].sort()).toEqual(
			then.files.map(({ path }) => path).sort(),
		);
		for (const file of then.files) {
			const stored = tree.get(file.path) as Uint8Array;
			if (file.path.endsWith('.md') || file.path === 'epicenter.json') {
				expect(sha256(stored)).toBe(file.version);
				continue;
			}
			const pointer = readLfsPointer(stored);
			expect(pointer).toEqual({ oid: file.version, size: file.size ?? 0 });
			const object = await readFile(
				lfsObjectPath(join(a, '.git'), file.version),
			);
			expect(sha256(new Uint8Array(object))).toBe(file.version);
		}
		const message = await gitText(['log', '-1', '--format=%B', id], { cwd: a });
		expect(message).toContain(`Epicenter-Change: ${seq}\n`);
		expect(message).toContain(`Epicenter-Folder: ${folder}\n`);
	}
	// The checkout holds the last change; the attachment it deleted is gone.
	expect(await readFile(join(a, 'notes/a.md'), 'utf8')).toContain('two');
	expect(existsSync(join(a, 'audio/take.webm'))).toBe(false);

	// Again, after another change: only the new one, over the old commits.
	await commit([{ path: 'notes/c.md', bytes: text('c\n') }]);
	const again = await exportGit({ folder, history: repository, dir: a });
	expect(again).toMatchObject({ from: 3, to: 4, checkout: 'moved' });
	const after = await commitsOf(a);
	expect(after.slice(0, 3)).toEqual(commits);
	expect(await readFile(join(a, 'notes/c.md'), 'utf8')).toBe('c\n');
	expect((await git(['fsck', '--strict'], { cwd: a })).code).toBe(0);
	// Nothing new: nothing written.
	expect(
		await exportGit({ folder, history: repository, dir: a }),
	).toMatchObject({
		from: 4,
		to: 4,
	});

	// A fresh export makes the same commits and tags.
	const b = join(scratch, 'export-b');
	await exportGit({ folder, history: repository, dir: b });
	expect(await commitsOf(b)).toEqual(after);
	expect((await gitText(['rev-parse', 'v1'], { cwd: b })).trim()).toBe(
		after[0] as string,
	);

	// A purged attachment keeps its pointer, so the history is the same; the export lists it.
	const purged = await purgeBlobs({
		db: server.db,
		store: server.blobs,
		folder,
		versions: [version(audio)],
		force: true,
	});
	expect(purged.purged).toEqual([version(audio)]);
	const c = join(scratch, 'export-c');
	const third = await exportGit({ folder, history: repository, dir: c });
	expect(third.purged).toEqual([
		{ seq: 1, path: 'audio/take.webm', version: version(audio) },
	]);
	expect(await commitsOf(c)).toEqual(after);
	expect(existsSync(lfsObjectPath(join(c, '.git'), version(audio)))).toBe(
		false,
	);

	// An export never writes over another folder's.
	const other = expectOk(await makeFolder(account));
	await expect(
		exportGit({
			folder: other,
			history: folderRepository(account, other),
			dir: a,
		}),
	).rejects.toThrow(`holds the export of folder ${folder}`);

	// Nor continues one in an older projection, whose attributes differ.
	const v1 = join(scratch, 'export-v1');
	await exportGit({ folder, history: repository, dir: v1 });
	await writeFile(
		join(v1, '.gitattributes'),
		'* filter=lfs diff=lfs merge=lfs -text\n*.[mM][dD] !filter !diff !merge text\n.gitattributes !filter !diff !merge text\n',
	);
	await gitText(['commit', '--quiet', '--amend', '--no-edit', '--all'], {
		cwd: v1,
	});
	await commit([{ path: 'notes/d.md', bytes: text('d\n') }]);
	await expect(
		exportGit({ folder, history: repository, dir: v1 }),
	).rejects.toThrow('older projection');
	expect(
		messageOf(folder, {
			seq: 9,
			files: [],
			digest: 'd',
			message: null,
			at: '',
			author: '',
			via: '',
			marks: [],
		}),
	).toContain('Epicenter-Change: 9');
}, 120_000);

/** A repository with history: LFS, a tag of each kind, a merge from a side branch, and a link. */
async function sourceRepository(name: string) {
	const dir = join(scratch, name);
	await mkdir(dir, { recursive: true });
	const run = (...args: string[]) => gitText(args, { cwd: dir });
	const at = (seconds: number) => ({
		GIT_AUTHOR_DATE: `${seconds} +0000`,
		GIT_COMMITTER_DATE: `${seconds} +0000`,
	});
	const commitAs = async (
		message: string,
		seconds: number,
		author = 'Ada <ada@example.test>',
	) => {
		const [name, email] = author.replace('>', '').split(' <');
		await gitText(['commit', '--quiet', '-m', message], {
			cwd: dir,
			env: {
				...at(seconds),
				GIT_AUTHOR_NAME: name as string,
				GIT_AUTHOR_EMAIL: email as string,
			},
		});
	};
	await run('init', '--quiet', '--initial-branch=main');
	await run('lfs', 'install', '--local');
	await run('lfs', 'track', '*.bin');
	const big = crypto.getRandomValues(new Uint8Array(30_000));
	await writeFile(join(dir, 'a.md'), '---\ntitle:   Spaced\n---\nfirst\n');
	await writeFile(join(dir, 'epicenter.json'), '{"title":"Vault"}\n');
	await writeFile(join(dir, 'big.bin'), big);
	await run('add', '.gitattributes', 'a.md', 'epicenter.json', 'big.bin');

	await commitAs('First draft\n\nWith a body.', 1_600_000_000);
	await run('tag', 'v1');
	await mkdir(join(dir, 'notes'), { recursive: true });
	await writeFile(join(dir, 'a.md'), '---\ntitle:   Spaced\n---\nsecond\n');
	await writeFile(join(dir, 'notes/b.md'), 'b\n');
	await symlink('a.md', join(dir, 'link.md'));
	await run('add', 'a.md', 'notes/b.md', 'link.md');
	await commitAs('Second', 1_600_000_100, 'Grace <grace@example.test>');
	await run('tag', '-a', 'v2', '-m', 'Version two');
	await run('checkout', '--quiet', '-b', 'side');
	await writeFile(join(dir, 's.md'), 'side\n');
	await run('add', 's.md');
	await commitAs('Side work', 1_600_000_150);
	await run('tag', 'side-only');
	await run('checkout', '--quiet', 'main');
	await gitText(['merge', '--quiet', '--no-ff', '-m', 'Merge side', 'side'], {
		cwd: dir,
		env: at(1_600_000_200),
	});
	await run('rm', '--quiet', 'notes/b.md');
	await commitAs('Drop b', 1_600_000_300);
	return { dir, big };
}

test('an import replays the first-parent history, keeps its bytes, never writes the source, and exports back the same files in order', async () => {
	const account = await server.signIn('importer');
	const { dir: source, big } = await sourceRepository('vault');
	const refsBefore = await gitText(['for-each-ref'], { cwd: source });
	const home = join(scratch, 'home-import', 'Epicenter');
	await mkdir(home, { recursive: true });
	const root = epicenterRoot(home);
	const imported = await importGit({ source, account, root, name: 'Vault' });
	expect(imported).toMatchObject({
		branch: 'main',
		commits: 4,
		changes: 4,
		marks: ['v1', 'v2'],
		original: null,
	});
	expect(imported.warnings).toEqual(
		expect.arrayContaining([
			expect.stringContaining('.gitattributes: hidden'),
			expect.stringContaining('link.md: a symbolic link'),
			expect.stringContaining("tag side-only: not on main's first-parent line"),
		]),
	);
	// The source is as it was.
	expect(await gitText(['for-each-ref'], { cwd: source })).toBe(refsBefore);
	expect(
		(await gitText(['status', '--porcelain'], { cwd: source })).trim(),
	).toBe('');

	// A real directory, without `.git`, holding the branch's files, front matter as it was.
	const local = join(home, 'Vault');
	expect(existsSync(join(local, '.git'))).toBe(false);
	expect(await readFile(join(local, 'a.md'), 'utf8')).toBe(
		'---\ntitle:   Spaced\n---\nsecond\n',
	);
	expect(new Uint8Array(await readFile(join(local, 'big.bin')))).toEqual(big);
	expect(await readFile(join(local, 's.md'), 'utf8')).toBe('side\n');
	expect(existsSync(join(local, 'notes/b.md'))).toBe(false);
	// Recorded as synced: the folder is this directory's.
	const found = expectOk(await identify({ root, account }));
	expect(
		found.bound.map(({ local, record }) => [local.name, record.folder]),
	).toEqual([['Vault', imported.folder]]);

	// Each commit's author, time, and message, in order.
	const repository = folderRepository(account, imported.folder);
	const log = expectOk(await repository.log({ after: 0 }));
	expect(log.map(({ author, at, message }) => [author, at, message])).toEqual([
		[
			'Ada <ada@example.test>',
			'2020-09-13T12:26:40.000Z',
			'First draft\n\nWith a body.',
		],
		['Grace <grace@example.test>', '2020-09-13T12:28:20.000Z', 'Second'],
		['Test <test@example.test>', '2020-09-13T12:30:00.000Z', 'Merge side'],
		['Ada <ada@example.test>', '2020-09-13T12:31:40.000Z', 'Drop b'],
	]);

	// Exported back: the same files at each commit, in the same order, and the tags.
	const back = join(scratch, 'export-back');
	await exportGit({ folder: imported.folder, history: repository, dir: back });
	const original = (
		await gitText(['rev-list', '--first-parent', '--reverse', 'main'], {
			cwd: source,
		})
	)
		.split('\n')
		.filter(Boolean);
	const exported = await commitsOf(back);
	expect(exported).toHaveLength(original.length);
	const kept = (tree: Map<string, Uint8Array>) =>
		new Map(
			[...tree].filter(([path]) => !path.startsWith('.') && path !== 'link.md'),
		);
	for (const [index, id] of original.entries()) {
		const theirs = kept(await treeOf(source, id));
		const ours = kept(await treeOf(back, exported[index] as string));
		expect([...ours.keys()].sort()).toEqual([...theirs.keys()].sort());
		for (const [path, bytes] of theirs)
			expect([path, sha256(ours.get(path) as Uint8Array)]).toEqual([
				path,
				sha256(bytes),
			]);
		expect(
			await gitText(
				['log', '-1', '--format=%an <%ae> %at%n%s', exported[index] as string],
				{ cwd: back },
			),
		).toBe(
			await gitText(['log', '-1', '--format=%an <%ae> %at%n%s', id], {
				cwd: source,
			}),
		);
	}
	expect((await gitText(['rev-parse', 'v1'], { cwd: back })).trim()).toBe(
		exported[0] as string,
	);
	expect((await gitText(['rev-parse', 'v2'], { cwd: back })).trim()).toBe(
		exported[1] as string,
	);
}, 120_000);

test('handing over moves the original aside with its .git and leaves a link into the Epicenter folder', async () => {
	const account = await server.signIn('handover');
	const { dir: source } = await sourceRepository('notes-repo');
	const home = join(scratch, 'home-handover', 'Epicenter');
	await mkdir(home, { recursive: true });
	const root = epicenterRoot(home);
	const imported = await importGit({
		source,
		account,
		root,
		replaceOriginal: true,
	});
	expect(imported.original?.movedTo).toBe(
		join(scratch, 'notes-repo (before Epicenter)'),
	);
	expect(
		existsSync(join(scratch, 'notes-repo (before Epicenter)', '.git')),
	).toBe(true);
	expect((await lstat(source)).isSymbolicLink()).toBe(true);
	expect(await readlink(source)).toBe(join(home, 'notes-repo'));
	expect(await readFile(join(source, 'a.md'), 'utf8')).toContain('second');
	// A source with uncommitted changes is never handed over.
	const { dir: dirty } = await sourceRepository('dirty-repo');
	await writeFile(join(dirty, 'a.md'), 'unsaved\n');
	await expect(
		importGit({ source: dirty, account, root, replaceOriginal: true }),
	).rejects.toThrow('uncommitted changes');
}, 120_000);
