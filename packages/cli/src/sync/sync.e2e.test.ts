/**
 * `epicenter init`, `sync`, `clone`, `forget`, `status`, and the merge driver,
 * end to end with stock `git` and `git-lfs` (spike 7's T0 to T8, with its
 * lessons applied): fresh CLI processes against a bare remote and a small
 * LFS server, in a sandbox.
 *
 * The sandbox is the safety rule spike 7 learned from committing into an
 * enclosing repository: a temporary directory, its own `HOME`,
 * `GIT_CONFIG_GLOBAL`, and data directories, and `GIT_CEILING_DIRECTORIES`
 * at the sandbox, so Git can never find a repository above it. The suite
 * refuses to run if the sandbox resolves to any repository. Every process
 * gets the sandbox environment and nothing else from this one but `PATH`.
 *
 * Key behaviors:
 * - T0: init refuses an enclosing repository unless --enclosing-ok, and sync
 *   commits only the registered data folder's paths
 * - T1, T2, T2b: notes merge by `settle` through the merge driver; the later
 *   arrival wins a key, under merge and under a person's `pull --rebase`
 * - T3: an edit beats a delete, both ways
 * - T4, T5: every non-note file travels as an LFS pointer; init repairs a
 *   clone missing its filters or bytes, and sync refuses one until then
 * - T6: a held index lock stops sync with nothing changed; concurrent syncs
 *   are serialized and a rejected push is retried, so every run succeeds
 * - T7: a rewritten remote main stops sync before it merges
 * - T8: a binary both sides replaced lands as a conflict copy (decision 44)
 * - clone, status, forget, sync of every registered folder, and --watch
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findConflicts } from '@epicenter/definition/merge';
import { formatNote, parseRowSource } from '@epicenter/definition/note';
import { type LfsServer, startLfsServer } from './lfs-server.test-support.ts';

const BIN = resolve(import.meta.dir, '..', 'bin.ts');
const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-sync-e2e-')));
const HOME = join(BOX, 'home');
const ENV: Record<string, string> = {
	PATH: process.env.PATH ?? '/usr/bin:/bin',
	HOME,
	TMPDIR: join(BOX, 'tmp'),
	XDG_CONFIG_HOME: join(HOME, '.config'),
	GIT_CONFIG_GLOBAL: join(HOME, '.gitconfig'),
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
	GIT_CEILING_DIRECTORIES: BOX,
	NO_PROXY: '127.0.0.1,localhost',
	EPICENTER_DATA_DIR: join(BOX, 'data'),
	EPICENTER_FOLDER_DIR: join(BOX, 'folders'),
};
/** The command link Git's configuration runs (`AppPaths.commandLink`). */
const EPICENTER = join(HOME, '.local', 'bin', 'epicenter');

type Ran = { code: number; out: string; stdout: string; stderr: string };

async function run(
	cwd: string,
	cmd: string[],
	env: Record<string, string> = {},
): Promise<Ran> {
	const proc = Bun.spawn(cmd, {
		cwd,
		env: { ...ENV, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr, out: `${stdout}${stderr}`.trim() };
}
const sh = (cwd: string, script: string) => run(cwd, ['sh', '-c', script]);
const git = (cwd: string, ...args: string[]) => run(cwd, ['git', ...args]);
const quiet = async (cwd: string, ...args: string[]) =>
	(await git(cwd, ...args)).stdout.trim();
const cli = (...args: string[]) => run(BOX, [EPICENTER, ...args]);
const init = (dir: string, ...flags: string[]) => cli('init', dir, ...flags);
const sync = (dir: string) => cli('sync', dir);
/** One `sync --json` round's status line. */
async function syncJson(dir: string) {
	const ran = await cli('sync', dir, '--json');
	const line = ran.stdout.trim().split('\n').at(-1) ?? '{}';
	return { ...ran, status: JSON.parse(line).sync as SyncLine };
}
type SyncLine = {
	folder: string;
	status: 'synced' | 'retry' | 'stopped';
	head?: string;
	notes: string[];
	message?: string;
};

const read = (dir: string, path: string) =>
	readFileSync(join(dir, path), 'utf8');
const write = (dir: string, path: string, text: string | Uint8Array) => {
	mkdirSync(join(dir, path, '..'), { recursive: true });
	writeFileSync(join(dir, path), text);
};
const edit = (dir: string, path: string, from: string, to: string) => {
	const text = read(dir, path);
	if (!text.includes(from))
		throw new Error(`${path} lacks ${JSON.stringify(from)}`);
	write(dir, path, text.replace(from, to));
};
const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');
const tree = (dir: string) => quiet(dir, 'rev-parse', 'HEAD^{tree}');
const head = (dir: string) => quiet(dir, 'rev-parse', 'HEAD');

/** In house style: formatting it again changes nothing. */
function inHouseStyle(text: string) {
	const parsed = parseRowSource(text);
	if (parsed.error !== null) return false;
	const formatted = formatNote(text, parsed.data.keyOrder);
	return formatted.error === null && formatted.data === text;
}

const REMOTE = join(BOX, 'remote.git');
const [A, B, C] = ['A', 'B', 'C'].map((name) => join(BOX, name)) as [
	string,
	string,
	string,
];
const NOTE = 'notes/meeting notes.md';
let lfs: LfsServer;

/** Who commits in a clone, and where its LFS bytes go. */
const connect = (dir: string, user: string) =>
	sh(
		dir,
		`git config user.name ${user} && git config user.email ${user}@example.invalid && git config lfs.url ${lfs.url}`,
	);

beforeAll(async () => {
	mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
	mkdirSync(ENV.TMPDIR as string, { recursive: true });
	writeFileSync(
		ENV.GIT_CONFIG_GLOBAL as string,
		'[user]\n\tname = sandbox\n\temail = sandbox@example.invalid\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n',
	);
	// The `epicenter` on this sandbox's command link: this checkout's CLI.
	writeFileSync(
		EPICENTER,
		`#!/bin/sh\nexec '${process.execPath}' '${BIN}' "$@"\n`,
	);
	chmodSync(EPICENTER, 0o755);
	const probe = await git(BOX, 'rev-parse', '--show-toplevel');
	if (probe.code === 0)
		throw new Error(
			`the sandbox ${BOX} resolves to the repository ${probe.stdout.trim()}; refusing to run`,
		);
	lfs = startLfsServer(join(BOX, 'lfs-store'));
});

afterAll(() => {
	lfs?.stop();
	rmSync(BOX, { recursive: true, force: true });
});

const LONG = 60_000;

describe('epicenter sync over stock git', () => {
	test(
		'setup: init a plain folder, init again changes nothing, a clone joins',
		async () => {
			await git(BOX, 'init', '-q', '--bare', '-b', 'main', REMOTE);
			write(
				A,
				NOTE,
				'---\ntitle: Weekly sync\nstatus: draft\ntags:\n  - work\n---\n# Weekly sync\n\nFirst paragraph stays the same.\n\nThe budget is 100 dollars and we ship on Friday.\n\nLast paragraph stays too.\n',
			);
			write(
				A,
				'notes/kept.md',
				'---\ntitle: Kept\n---\nA note one side edits and the other deletes.\n',
			);
			write(A, 'notes/gone.md', '---\ntitle: Gone\n---\nThe mirror case.\n');
			write(A, 'notes/secret.md', '---\ntitle: Secret\n---\nfirst\n');

			const first = await init(A);
			expect(first.code).toBe(0);
			for (const step of [
				'git init',
				'.gitattributes committed',
				'.gitignore committed',
				'merge.epicenter.driver set',
				'git lfs install --local',
				'registered',
			])
				expect(first.out).toContain(step);
			await connect(A, 'alice');
			await git(A, 'remote', 'add', 'origin', REMOTE);

			const snapshot = async () =>
				(
					await sh(
						A,
						'cat .git/config .gitattributes "$GIT_CONFIG_GLOBAL"; shasum .git/hooks/* | grep -v sample; git rev-parse HEAD; git status --porcelain',
					)
				).out;
			const before = await snapshot();
			const again = await init(A);
			expect(again.out).toContain('nothing to do');
			expect(await snapshot()).toBe(before);
			expect(
				await quiet(BOX, 'config', '--global', '--get-all', 'epicenter.folder'),
			).toBe(A);

			const attr = await quiet(
				A,
				'check-attr',
				'filter',
				'merge',
				'--',
				'media/clip.webm',
				'.gitattributes',
				'.obsidian/workspace.json',
				'sub/.trash/a.webm',
				NOTE,
			);
			expect(attr.split('\n')).toEqual([
				'media/clip.webm: filter: lfs',
				'media/clip.webm: merge: lfs',
				'.gitattributes: filter: unspecified',
				'.gitattributes: merge: unspecified',
				'.obsidian/workspace.json: filter: unspecified',
				'.obsidian/workspace.json: merge: unspecified',
				'sub/.trash/a.webm: filter: unspecified',
				'sub/.trash/a.webm: merge: unspecified',
				`${NOTE}: filter: unspecified`,
				`${NOTE}: merge: epicenter`,
			]);

			// Operating system clutter and the device outbox never travel (decision 58 keeps hidden paths raw, not ignored).
			write(A, '.DS_Store', new Uint8Array([0, 0, 0, 1, 66, 117, 100, 49]));
			write(A, 'notes/.DS_Store', new Uint8Array([0, 1, 2]));
			write(A, '.epicenter/outbox/c1.json', '{"state":"pending"}\n');
			expect(
				(
					await quiet(
						A,
						'check-ignore',
						'.DS_Store',
						'notes/.DS_Store',
						'.epicenter/outbox/c1.json',
						'.obsidian/workspace.json',
					)
				).split('\n'),
			).toEqual(['.DS_Store', 'notes/.DS_Store', '.epicenter/outbox/c1.json']);

			const pushed = await syncJson(A);
			expect(pushed.code).toBe(0);
			expect(
				await quiet(
					A,
					'ls-files',
					'.DS_Store',
					'notes/.DS_Store',
					'.epicenter',
				),
			).toBe('');
			expect(pushed.status.status).toBe('synced');
			expect(pushed.status.head).toBe(await quiet(REMOTE, 'rev-parse', 'main'));

			await git(BOX, 'clone', '-q', REMOTE, B);
			await connect(B, 'bob');
			const joined = await init(B);
			expect(joined.out).not.toContain('.gitattributes');
			expect(joined.out).toContain('merge.epicenter.driver set');
			expect((await sync(B)).code).toBe(0);
		},
		LONG,
	);

	test(
		'a .MD note is a note: committed as text, merged by the driver on both clones',
		async () => {
			const LOUD = 'notes/Loud.MD';
			write(A, LOUD, 'one\ntwo\n');
			expect((await syncJson(A)).status.status).toBe('synced');
			expect((await syncJson(B)).status.status).toBe('synced');
			expect(await quiet(A, 'cat-file', '-p', `HEAD:${LOUD}`)).toBe('one\ntwo');
			expect(await quiet(A, 'check-attr', 'filter', 'merge', '--', LOUD)).toBe(
				`${LOUD}: filter: unspecified\n${LOUD}: merge: epicenter`,
			);
			edit(A, LOUD, 'one', 'ONE');
			edit(B, LOUD, 'two', 'TWO');
			expect((await syncJson(A)).status.status).toBe('synced');
			const merged = await syncJson(B);
			expect(merged.status.status).toBe('synced');
			expect((await syncJson(A)).status.status).toBe('synced');
			expect(read(A, LOUD)).toBe('ONE\nTWO\n');
			expect(read(B, LOUD)).toBe('ONE\nTWO\n');
		},
		LONG,
	);

	test(
		'T0: an enclosing repository is adopted only on purpose, and sync commits only the data folder',
		async () => {
			const OUTER = join(BOX, 'outer');
			await git(BOX, 'init', '-q', '-b', 'main', OUTER);
			write(OUTER, 'secret.txt', 'not data\n');
			write(OUTER, 'tracked.txt', 'one\n');
			await sh(OUTER, 'git add tracked.txt && git commit -qm start');
			write(OUTER, 'tracked.txt', 'two\n');
			write(OUTER, 'data/note.md', '---\ntitle: x\n---\nbody\n');
			const DATA = join(OUTER, 'data');

			const refused = await init(DATA);
			expect(refused.code).toBe(2);
			expect(refused.out).toContain('inside the existing repository');
			expect(existsSync(join(DATA, '.gitattributes'))).toBe(false);
			const unadopted = await sync(DATA);
			expect(unadopted.code).toBe(2);
			expect(await quiet(OUTER, 'rev-list', '--count', '--all')).toBe('1');

			const adopted = await init(DATA, '--enclosing-ok');
			expect(adopted.code).toBe(0);
			expect(existsSync(join(DATA, '.gitattributes'))).toBe(true);
			const synced = await syncJson(DATA);
			expect(synced.code).toBe(0);
			expect(synced.status.notes).toContain('no remote: committed locally');
			const committed = (
				await quiet(OUTER, 'log', '--name-only', '--format=', 'HEAD~2..HEAD')
			)
				.split('\n')
				.filter(Boolean)
				.sort();
			expect(committed).toEqual([
				'data/.gitattributes',
				'data/.gitignore',
				'data/note.md',
			]);
			expect((await git(OUTER, 'status', '--porcelain')).stdout).toBe(
				' M tracked.txt\n?? secret.txt\n',
			);
			await cli('forget', DATA);
		},
		LONG,
	);

	test(
		'T1: different fields both land; one sentence both edited is one block',
		async () => {
			edit(A, NOTE, 'status: draft', 'status: review');
			edit(
				A,
				NOTE,
				'100 dollars and we ship on Friday',
				'150 dollars and we ship on Friday',
			);
			edit(B, NOTE, '  - work\n', '  - work\n  - planning\n');
			edit(
				B,
				NOTE,
				'100 dollars and we ship on Friday',
				'200 dollars and we ship on Friday',
			);
			expect((await sync(A)).code).toBe(0);
			const merged = await syncJson(B);
			expect(merged.code).toBe(0);
			expect(merged.status.notes.join('\n')).toMatch(
				/notes\/meeting notes\.md: merge; incoming=%A; conflict block written/,
			);
			expect((await sync(A)).code).toBe(0);

			const text = read(B, NOTE);
			expect(await tree(A)).toBe(await tree(B));
			const parsed = parseRowSource(text);
			if (parsed.error !== null)
				throw new Error('the merged note does not parse');
			expect(parsed.data.document.fields).toEqual({
				title: 'Weekly sync',
				status: 'review',
				tags: ['work', 'planning'],
			});
			expect(findConflicts(text)).toHaveLength(1);
			expect(inHouseStyle(text)).toBe(true);
			expect(await quiet(A, 'ls-files', '-u')).toBe('');
			expect(await quiet(B, 'ls-files', '-u')).toBe('');
		},
		LONG,
	);

	test(
		'T2: one field both set takes the later arrival, and the loser stays in history',
		async () => {
			edit(A, NOTE, 'title: Weekly sync', 'title: From Alice');
			edit(B, NOTE, 'title: Weekly sync', 'title: From Bob');
			await sync(A);
			await sync(B);
			await sync(A);
			expect(read(A, NOTE)).toContain('title: From Bob');
			expect(read(A, NOTE)).toBe(read(B, NOTE));
			expect(findConflicts(read(A, NOTE))).toHaveLength(1);
			const full = await sh(
				REMOTE,
				`git log --full-history -p main -- "${NOTE}" | grep -c '^+title: From Alice'`,
			);
			expect(full.stdout.trim()).toBe('1');
		},
		LONG,
	);

	test(
		"T2b: a person's own git pull --rebase swaps the sides, and the driver keeps the later arrival",
		async () => {
			edit(A, NOTE, 'title: From Bob', 'title: Alice again');
			edit(B, NOTE, 'title: From Bob', 'title: Bob by rebase');
			await sync(A);
			const rebased = await sh(
				B,
				'git add -A && git commit -qm "bob by hand" && git pull -q --rebase origin main && git push -q origin HEAD:main',
			);
			expect(rebased.code).toBe(0);
			expect(rebased.out).toContain('rebase; incoming=%B');
			await sync(A);
			expect(read(A, NOTE)).toContain('title: Bob by rebase');
		},
		LONG,
	);

	test(
		'T3: an edit beats a delete, both ways',
		async () => {
			await sync(B);
			edit(
				A,
				'notes/kept.md',
				'and the other deletes.',
				'and the other deletes. Edited by Alice.',
			);
			rmSync(join(B, 'notes/kept.md'));
			rmSync(join(A, 'notes/gone.md'));
			edit(
				B,
				'notes/gone.md',
				'The mirror case.',
				'The mirror case. Edited by Bob.',
			);
			await sync(A);
			const kept = await syncJson(B);
			expect(kept.code).toBe(0);
			expect(kept.status.notes).toContain(
				'edit beats delete: kept notes/kept.md (remote edit)',
			);
			expect(kept.status.notes).toContain(
				'edit beats delete: kept notes/gone.md (local edit)',
			);
			await sync(A);
			for (const dir of [A, B]) {
				expect(read(dir, 'notes/kept.md')).toContain('Edited by Alice');
				expect(read(dir, 'notes/gone.md')).toContain('Edited by Bob');
			}
			expect(await tree(A)).toBe(await tree(B));
		},
		LONG,
	);

	const clip = randomBytes(2 * 1024 * 1024);
	test(
		'T4: a binary file travels through LFS; the remote holds only a pointer',
		async () => {
			write(A, 'media/clip.webm', clip);
			expect((await sync(A)).code).toBe(0);
			expect((await sync(B)).code).toBe(0);
			expect(sha256(readFileSync(join(B, 'media/clip.webm')))).toBe(
				sha256(clip),
			);
			const pointer = await quiet(
				REMOTE,
				'cat-file',
				'-p',
				'main:media/clip.webm',
			);
			expect(
				pointer.startsWith('version https://git-lfs.github.com/spec/v1'),
			).toBe(true);
			expect(pointer).toContain(sha256(clip));
			const largest = await sh(
				REMOTE,
				"git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectsize)' | awk '$1==\"blob\"{print $2}' | sort -n | tail -1",
			);
			expect(Number(largest.stdout.trim())).toBeLessThan(2000);
			expect(existsSync(join(lfs.objects, sha256(clip)))).toBe(true);
		},
		LONG,
	);

	test(
		'T5: init repairs a clone missing its bytes or its filters, and sync refuses it until then',
		async () => {
			await git(BOX, 'clone', '-q', REMOTE, C);
			await connect(C, 'carol');
			expect(
				read(C, 'media/clip.webm').startsWith('version https://git-lfs'),
			).toBe(true);
			const pulled = await init(C);
			expect(pulled.out).toContain('git lfs pull (1 pointer file');
			expect(sha256(readFileSync(join(C, 'media/clip.webm')))).toBe(
				sha256(clip),
			);

			await sh(
				C,
				'rm .git/hooks/pre-push .git/hooks/post-checkout .git/hooks/post-commit .git/hooks/post-merge && git config --local --remove-section filter.lfs && git config --local --unset merge.epicenter.driver',
			);
			const raw = randomBytes(64 * 1024);
			write(C, 'media/raw.webm', raw);
			const unsetUp = await head(C);
			const refused = await sync(C);
			expect(refused.code).toBe(2);
			expect(refused.out).toContain('not set up');
			expect(await head(C)).toBe(unsetUp);
			expect(await quiet(C, 'ls-files', '--', 'media/raw.webm')).toBe('');

			const repaired = await init(C);
			expect(repaired.out).toContain('merge.epicenter.driver set');
			expect(repaired.out).toContain(
				'git lfs install --local (missing: filter.lfs.clean, filter.lfs.smudge, filter.lfs.process, filter.lfs.required, hooks/pre-push, hooks/post-checkout, hooks/post-commit, hooks/post-merge)',
			);
			expect(repaired.out).not.toMatch(/attributes|registered|lfs pull/);
			expect((await init(C)).out).toContain('nothing to do');
			expect((await sync(C)).code).toBe(0);
			expect((await sync(A)).code).toBe(0);
			expect(sha256(readFileSync(join(A, 'media/raw.webm')))).toBe(sha256(raw));
			expect(
				(
					await quiet(REMOTE, 'cat-file', '-p', 'main:media/raw.webm')
				).startsWith('version https://git-lfs'),
			).toBe(true);
			await sync(B);
		},
		LONG,
	);

	test(
		'T6a: an index lock held by another program stops sync with nothing changed',
		async () => {
			write(
				A,
				'notes/locked.md',
				'---\ntitle: Locked\n---\nwritten while locked\n',
			);
			const before = await head(A);
			writeFileSync(join(A, '.git/index.lock'), '');
			const locked = await syncJson(A);
			expect(locked.code).toBe(1);
			expect(locked.status.status).toBe('retry');
			expect(locked.status.message).toContain('index.lock');
			expect(await head(A)).toBe(before);
			expect(existsSync(join(A, '.git/MERGE_HEAD'))).toBe(false);
			expect(await quiet(A, 'status', '--porcelain')).toBe(
				'?? notes/locked.md',
			);
			unlinkSync(join(A, '.git/index.lock'));
			expect((await sync(A)).code).toBe(0);
			expect(await quiet(A, 'status', '--porcelain')).toBe('');
		},
		LONG,
	);

	test(
		'T6b: a lock before the merge keeps the local commit and starts no merge',
		async () => {
			write(B, 'notes/bob-side.md', '---\ntitle: Bob side\n---\nlocal\n');
			await sh(B, 'git add notes/bob-side.md && git commit -qm "bob side"');
			const local = await head(B);
			writeFileSync(join(B, '.git/index.lock'), '');
			const locked = await sync(B);
			expect(locked.code).toBe(1);
			expect(await head(B)).toBe(local);
			expect(existsSync(join(B, '.git/MERGE_HEAD'))).toBe(false);
			expect(existsSync(join(B, 'notes/locked.md'))).toBe(false);
			unlinkSync(join(B, '.git/index.lock'));
			expect((await sync(B)).code).toBe(0);
			expect(existsSync(join(B, 'notes/locked.md'))).toBe(true);
			await sync(A);
		},
		LONG,
	);

	test(
		'T6c: concurrent syncs in one clone take turns, and a rejected push is retried',
		async () => {
			const failed: string[] = [];
			for (let round = 0; round < 6; round++) {
				write(
					A,
					`notes/race-${round}.md`,
					`---\ntitle: Race ${round}\n---\nround ${round}\n`,
				);
				edit(
					B,
					NOTE,
					'Last paragraph stays too.',
					`Last paragraph stays too. b${round}`,
				);
				const results = await Promise.all([sync(A), sync(A), sync(B)]);
				for (const result of results)
					if (result.code !== 0)
						failed.push(`round ${round}: exit ${result.code}: ${result.out}`);
			}
			expect(failed).toEqual([]);
			await sync(A);
			await sync(B);
			await sync(A);
			expect(await tree(A)).toBe(await tree(B));
			for (let round = 0; round < 6; round++)
				expect(existsSync(join(B, `notes/race-${round}.md`))).toBe(true);
			expect(read(A, NOTE)).toContain('b5');
			for (const dir of [A, B, REMOTE])
				expect((await git(dir, 'fsck', '--full', '--no-progress')).code).toBe(
					0,
				);
		},
		LONG * 3,
	);

	test(
		'T7: a rewritten remote main stops sync before it merges',
		async () => {
			edit(
				A,
				'notes/secret.md',
				'first',
				'first\nX: a line the owner later removes',
			);
			await sync(A);
			await sync(B);
			const dropped = await head(A);
			await sh(
				A,
				`git reset -q --hard HEAD~1 && printf -- '---\\ntitle: Rewritten\\n---\\nafter the rewrite\\n' > notes/rewrite.md && git add notes/rewrite.md && git commit -qm rewrite && git push -q --force origin HEAD:main`,
			);
			const rewritten = await quiet(REMOTE, 'rev-parse', 'main');
			edit(B, 'notes/bob-side.md', 'local', 'local, edited after the rewrite');
			const bHead = await head(B);

			const stopped = await syncJson(B);
			expect(stopped.code).toBe(2);
			expect(stopped.status.status).toBe('stopped');
			expect(stopped.status.message).toContain('the remote main was rewritten');
			expect(await quiet(REMOTE, 'rev-parse', 'main')).toBe(rewritten);
			expect(
				(await git(B, 'merge-base', '--is-ancestor', rewritten, 'HEAD')).code,
			).toBe(1);
			expect(existsSync(join(B, '.git/MERGE_HEAD'))).toBe(false);
			expect(await quiet(B, 'rev-parse', 'HEAD~1')).toBe(bHead);

			const rewriter = await sync(A);
			expect(rewriter.code).toBe(2);
			await git(A, 'update-ref', 'refs/epicenter/last-seen', 'origin/main');
			expect((await sync(A)).code).toBe(0);
			const recovered = await sh(
				B,
				'git rebase -q --onto origin/main refs/epicenter/last-seen && git update-ref refs/epicenter/last-seen origin/main',
			);
			expect(recovered.code).toBe(0);
			expect((await sync(B)).code).toBe(0);
			await sync(A);
			expect(read(A, 'notes/secret.md')).not.toContain('X: a line');
			expect(read(A, 'notes/bob-side.md')).toContain('after the rewrite');
			expect(existsSync(join(B, 'notes/rewrite.md'))).toBe(true);
			expect(await tree(A)).toBe(await tree(B));
			expect(
				(await git(REMOTE, 'merge-base', '--is-ancestor', dropped, 'main'))
					.code,
			).toBe(1);
		},
		LONG,
	);

	test(
		'T8: a binary both clones replaced lands as a conflict copy beside it',
		async () => {
			const first = randomBytes(4096);
			const second = randomBytes(4096);
			write(A, 'media/clip.webm', first);
			write(B, 'media/clip.webm', second);
			expect((await sync(A)).code).toBe(0);
			const copied = await syncJson(B);
			expect(copied.code).toBe(0);
			const sibling = `media/clip (conflict ${sha256(second).slice(0, 7)}).webm`;
			expect(copied.status.notes).toContain(`conflict copy: ${sibling}`);
			expect((await sync(A)).code).toBe(0);
			for (const dir of [A, B]) {
				expect(sha256(readFileSync(join(dir, 'media/clip.webm')))).toBe(
					sha256(first),
				);
				expect(sha256(readFileSync(join(dir, sibling)))).toBe(sha256(second));
			}
			expect(
				await quiet(REMOTE, 'cat-file', '-p', `main:${sibling}`),
			).toContain(sha256(second));
			expect(await tree(A)).toBe(await tree(B));
			for (const dir of [A, B, C, REMOTE])
				expect((await git(dir, 'fsck', '--full', '--no-progress')).code).toBe(
					0,
				);
		},
		LONG,
	);

	test(
		'clone: git clone, then init, then the LFS bytes, registered for sync',
		async () => {
			const D = join(BOX, 'D');
			// The clone reads LFS bytes from the URL the global config names for this remote.
			await git(BOX, 'config', '--global', `lfs.${REMOTE}.url`, lfs.url);
			await git(BOX, 'config', '--global', 'lfs.url', lfs.url);
			const cloned = await cli('clone', REMOTE, D, '--json');
			expect(cloned.code).toBe(0);
			expect(sha256(readFileSync(join(D, 'media/clip.webm')))).toBe(
				sha256(readFileSync(join(A, 'media/clip.webm'))),
			);
			expect(
				await quiet(D, 'config', '--local', 'merge.epicenter.driver'),
			).toBe(`'${EPICENTER}' merge-driver %O %A %B %P`);
			expect(
				await quiet(BOX, 'config', '--global', '--get-all', 'epicenter.folder'),
			).toContain(D);
			expect(await quiet(D, 'status', '--porcelain')).toBe('');
		},
		LONG,
	);

	test(
		'status reads changes, ahead and behind, without writing',
		async () => {
			write(A, 'notes/unsynced.md', '---\ntitle: Unsynced\n---\nlocal\n');
			const status = await cli('status', A, '--json');
			expect(status.code).toBe(0);
			const { status: line } = JSON.parse(status.stdout);
			expect(line).toMatchObject({
				folder: A,
				repository: A,
				branch: 'main',
				registered: true,
				remote: REMOTE,
				ahead: 0,
				behind: 0,
				changes: [{ status: '??', path: 'notes/unsynced.md' }],
			});
			expect(await quiet(A, 'status', '--porcelain')).toBe(
				'?? notes/unsynced.md',
			);
		},
		LONG,
	);

	test(
		'sync without a path syncs every registered folder; forget unregisters one',
		async () => {
			const all = await cli('sync', '--json');
			const lines = all.stdout
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line).sync as SyncLine);
			expect(lines.map((line) => line.folder).sort()).toEqual(
				[A, B, C, join(BOX, 'D')].sort(),
			);
			expect(lines.filter((line) => line.status !== 'synced')).toEqual([]);
			expect(all.code).toBe(0);
			expect(
				await quiet(REMOTE, 'cat-file', '-t', 'main:notes/unsynced.md'),
			).toBe('blob');

			const forgot = await cli('forget', C);
			expect(forgot.code).toBe(0);
			expect(
				await quiet(BOX, 'config', '--global', '--get-all', 'epicenter.folder'),
			).not.toContain(C);
			const refused = await sync(C);
			expect(refused.code).toBe(2);
			expect(refused.out).toContain('epicenter init');
		},
		LONG,
	);

	test(
		'status without a path reads every registered folder, and names one gone from disk',
		async () => {
			const M = join(BOX, 'M');
			mkdirSync(M);
			expect((await init(M)).code).toBe(0);
			rmSync(M, { recursive: true, force: true });

			const all = await cli('status', '--json');
			expect(all.code).toBe(0);
			const lines = all.stdout
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line).status);
			expect(lines.map((line) => line.folder).sort()).toEqual(
				[A, B, join(BOX, 'D'), M].sort(),
			);
			expect(lines.find((line) => line.folder === M)).toEqual({
				folder: M,
				problem: 'not on disk',
			});
			expect(lines.find((line) => line.folder === A)).toMatchObject({
				registered: true,
				adopted: true,
				remote: REMOTE,
			});
			const text = await cli('status');
			expect(text.out).toContain(`${M}: not on disk`);

			expect((await cli('forget', M)).code).toBe(0);
			const after = await cli('status', '--json');
			expect(after.stdout).not.toContain(M);
		},
		LONG,
	);

	test(
		"init keeps a person's own attributes and manages only its block",
		async () => {
			const E = join(BOX, 'E');
			write(E, '.gitattributes', '*.txt text eol=lf\n');
			expect((await init(E)).code).toBe(0);
			const attributes = read(E, '.gitattributes');
			expect(attributes.startsWith('*.txt text eol=lf\n')).toBe(true);
			expect(attributes).toContain('# BEGIN epicenter');
			write(E, '.gitattributes', `${attributes}*.csv diff\n`);
			expect((await init(E)).out).not.toContain('.gitattributes written');
			expect(read(E, '.gitattributes').endsWith('*.csv diff\n')).toBe(true);
			await cli('forget', E);
		},
		LONG,
	);

	test(
		'sync --watch commits and pushes what an app saves, until stopped',
		async () => {
			const watching = Bun.spawn(
				[EPICENTER, 'sync', A, '--watch', '--interval', '1', '--json'],
				{
					cwd: BOX,
					env: ENV,
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			await Bun.sleep(1500);
			write(
				A,
				'notes/watched.md',
				'---\ntitle: Watched\n---\nsaved by an app\n',
			);
			const deadline = Date.now() + 20_000;
			while (
				(await git(REMOTE, 'cat-file', '-e', 'main:notes/watched.md')).code !==
				0
			) {
				if (Date.now() > deadline)
					throw new Error('watch never pushed the new note');
				await Bun.sleep(200);
			}
			watching.kill('SIGTERM');
			await watching.exited;
			const lines = (await new Response(watching.stdout).text())
				.trim()
				.split('\n');
			expect(lines.length).toBeGreaterThan(1);
			expect(lines.every((line) => JSON.parse(line).sync.folder === A)).toBe(
				true,
			);
		},
		LONG,
	);

	test(
		"sync --watch --desktop ends when its stdin closes, as it does when the app dies; a person's watch does not",
		async () => {
			const start = (...flags: string[]) =>
				Bun.spawn(
					[
						EPICENTER,
						'sync',
						A,
						'--watch',
						'--interval',
						'1',
						'--json',
						...flags,
					],
					{ cwd: BOX, env: ENV, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
				);
			/** Resolves once the watcher has reported its first round. */
			const firstRound = async (watching: ReturnType<typeof start>) => {
				const reader = watching.stdout.getReader();
				await reader.read();
				reader.releaseLock();
			};
			const desktop = start('--desktop');
			const person = start();
			await Promise.all([firstRound(desktop), firstRound(person)]);

			// The kernel closes the app's end of the pipe however the app ends.
			desktop.stdin.end();
			person.stdin.end();
			const ended = await Promise.race([
				desktop.exited,
				Bun.sleep(10_000).then(() => 'still running' as const),
			]);
			if (ended === 'still running') desktop.kill('SIGKILL');
			expect(ended).toBe(129);

			await Bun.sleep(1500);
			expect(person.exitCode).toBeNull();
			person.kill('SIGTERM');
			expect(await person.exited).toBe(143);
		},
		LONG,
	);
});
