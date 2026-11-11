/**
 * A call commits exactly the paths it wrote, holding the app's lock from its
 * first write, and a snapshot with no call commits what is pending as an
 * outside change (ADR-0850). Status names an app with no backup and one whose
 * backup has never received its branch. In process, against a real
 * repository in a temporary folder.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Action,
	defineAction,
	defineApp,
	field,
	folder,
} from '@epicenter/app';
import { folderOnDisk } from './disk.ts';
import type { Runnable } from './home.ts';
import { hold } from './lock.ts';
import { runAction } from './run.ts';
import { gitIn } from './runner.test-support.ts';
import { snapshot, statusOf } from './snapshot.ts';
import { syncOne } from './sync.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

/** What `pause` waits for between its writes; each test that runs it makes a new one. */
let gate = Promise.withResolvers<void>();

const actions = {
	write: defineAction({
		description: 'Write a page',
		input: { page: field.text() },
		positional: ['page'],
		run: async ({ page }) => {
			await folder.write(`${page}.md`, page);
			return page;
		},
	}),
	half: defineAction({
		description: 'Write a page, then throw',
		input: { page: field.text() },
		positional: ['page'],
		run: async ({ page }) => {
			await folder.write(`${page}.md`, page);
			throw new Error('stopped halfway');
		},
	}),
	pause: defineAction({
		description: 'Write a page, wait for the gate, then write another',
		input: { page: field.text() },
		positional: ['page'],
		run: async ({ page }) => {
			await folder.write(`${page}.md`, page);
			await gate.promise;
			await folder.write(`${page}-after.md`, page);
		},
	}),
	scratch: defineAction({
		description: 'Write a page, and paths no commit takes',
		input: { page: field.text() },
		positional: ['page'],
		run: async ({ page }) => {
			await folder.write(`${page}.md`, page);
			await folder.write('gone.md', 'gone');
			await folder.delete('gone.md');
			await folder.write('node_modules/seen.txt', page);
			await folder.write('token.local', 'secret');
		},
	}),
};

/** The notes app in a new repository with one commit, as the runner finds it. */
async function setup() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-snap-')));
	roots.push(dir);
	await writeFile(join(dir, 'a.md'), 'a\n');
	await writeFile(
		join(dir, '.gitignore'),
		'node_modules/\n*.local\n*.local.*\n',
	);
	await gitIn(dir, 'init', '-q');
	await gitIn(dir, 'config', 'user.name', 'Epicenter Test');
	await gitIn(dir, 'config', 'user.email', 'epicenter-test@example.com');
	await gitIn(dir, 'add', '-A');
	await gitIn(dir, 'commit', '-q', '-m', 'initial');
	const located = {
		ok: true,
		entry: 'notes',
		name: 'notes',
		folder: dir,
		realPath: dir,
		app: defineApp({ description: 'Notes', collections: {}, actions }),
		actions: actions as Record<string, Action>,
		context: { folder: folderOnDisk(dir) },
	} as Runnable;
	const run = (key: keyof typeof actions, page: string) =>
		runAction(located, key, actions[key] as Action, { page });
	const head = () => gitIn(dir, 'rev-parse', 'HEAD');
	const message = () => gitIn(dir, 'log', '-1', '--format=%B');
	const files = () => gitIn(dir, 'show', '--name-only', '--format=', 'HEAD');
	/** What is left pending: changed, staged, and untracked paths. */
	const left = async () => ({
		changed: await gitIn(dir, 'diff', '--name-only'),
		staged: await gitIn(dir, 'diff', '--cached', '--name-only'),
		untracked: await gitIn(dir, 'ls-files', '--others', '--exclude-standard'),
	});
	return { dir, run, head, message, files, left };
}

test('a call commits what it wrote, named for the call, before it answers', async () => {
	const f = await setup();
	const run = await f.run('write', 'monday');
	expect(run).toEqual({
		answer: { returned: 'monday' },
		committed: { committed: { subject: 'notes: write monday', files: 1 } },
	});
	expect(await f.message()).toBe('notes: write monday');
	expect(await f.files()).toBe('monday.md');
	expect(await snapshot('notes', f.dir)).toEqual({ committed: null });
	expect(await statusOf(f.dir)).toEqual({ pending: 0, backup: 'none' });
});

test('status names an origin that has never received the branch, and counts once it has', async () => {
	const f = await setup();
	const backup = join(f.dir, '.git', 'backup.git');
	await gitIn(f.dir, 'init', '-q', '--bare', backup);
	await gitIn(f.dir, 'remote', 'add', 'origin', backup);
	expect(await statusOf(f.dir)).toEqual({ pending: 0, backup: 'never' });
	const branch = await gitIn(f.dir, 'symbolic-ref', '--short', 'HEAD');
	await gitIn(f.dir, 'push', '-q', 'origin', `HEAD:${branch}`);
	expect(await statusOf(f.dir)).toEqual({ pending: 0, unpushed: 0 });
});

test("a call's commit holds only its paths; a hand edit and a staged file stay pending", async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'a.md'), 'by hand\n');
	await writeFile(join(f.dir, 'staged.md'), 'staged\n');
	await gitIn(f.dir, 'add', 'staged.md');
	// A path is a path, never a pattern: `star*.md` does not take `stars.md`.
	await writeFile(join(f.dir, 'stars.md'), 'by hand\n');
	expect((await f.run('write', 'star*')).committed).toEqual({
		committed: { subject: 'notes: write star*', files: 1 },
	});
	expect(await f.message()).toBe('notes: write star*');
	expect(await f.files()).toBe('star*.md');
	expect(await f.left()).toEqual({
		changed: 'a.md',
		staged: 'staged.md',
		untracked: 'stars.md',
	});
});

test('a run that throws after writing commits its writes as the call that threw', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'a.md'), 'by hand\n');
	const run = await f.run('half', 'tuesday');
	expect(run.answer).toEqual({ threw: { message: 'stopped halfway' } });
	expect(await readFile(join(f.dir, 'tuesday.md'), 'utf8')).toBe('tuesday');
	expect(run.committed).toEqual({
		committed: { subject: 'notes: half tuesday (threw)', files: 1 },
	});
	expect(await f.message()).toBe('notes: half tuesday (threw)');
	expect(await f.files()).toBe('tuesday.md');
	expect(await f.left()).toEqual({
		changed: 'a.md',
		staged: '',
		untracked: '',
	});
});

test('a call skips what it created and deleted and what is ignored, without an error', async () => {
	const f = await setup();
	// It wrote node_modules/seen.txt, gone.md, kept.md, and token.local.
	expect((await f.run('scratch', 'kept')).committed).toEqual({
		committed: { subject: 'notes: scratch kept', files: 1 },
	});
	expect(await f.files()).toBe('kept.md');
	const before = await f.head();
	// The same call again changes nothing it would take, so it commits nothing.
	expect((await f.run('scratch', 'kept')).committed).toEqual({
		committed: null,
	});
	expect(await f.head()).toBe(before);
});

test('a snapshot with no call takes everything pending, named changed outside epicenter or by its message', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'b.md'), 'b\n');
	await snapshot('notes', f.dir);
	expect(await f.message()).toBe('notes: changed outside epicenter');
	expect(await f.files()).toBe('b.md');
	await writeFile(join(f.dir, 'a.md'), 'tidied\n');
	await writeFile(join(f.dir, 'c.md'), 'c\n');
	expect(await snapshot('notes', f.dir, { message: 'tidy the pages' })).toEqual(
		{ committed: { subject: 'notes: tidy the pages', files: 2 } },
	);
	expect(await f.message()).toBe('notes: tidy the pages');
	expect(await f.files()).toBe('a.md\nc.md');
});

test('snapshot refuses a revert in progress without staging or committing', async () => {
	const f = await setup();
	const before = await f.head();
	const gitPath = await gitIn(f.dir, 'rev-parse', '--git-path', 'REVERT_HEAD');
	await writeFile(join(f.dir, gitPath), `${before}\n`);
	await writeFile(join(f.dir, 'pending.md'), 'pending\n');
	expect(await snapshot('notes', f.dir)).toEqual({
		failed: {
			message: expect.stringContaining(
				'middle of a merge, rebase, revert, or cherry-pick',
			),
			next: `git -C ${f.dir} status`,
		},
	});
	expect(await f.head()).toBe(before);
	expect(await gitIn(f.dir, 'diff', '--cached', '--name-only')).toBe('');
	expect(await gitIn(f.dir, 'status', '--porcelain')).toContain(
		'?? pending.md',
	);
});

test('a *.local file the .gitignore lets through is refused before anything is staged', async () => {
	const f = await setup();
	await writeFile(join(f.dir, '.gitignore'), 'node_modules/\n');
	await gitIn(f.dir, 'commit', '-qam', 'no *.local in .gitignore');
	const before = await f.head();
	const refused = {
		failed: {
			message:
				'token.local would be committed; add *.local and *.local.* to notes/.gitignore',
		},
	};
	expect((await f.run('scratch', 'kept')).committed).toEqual(refused);
	expect(await snapshot('notes', f.dir)).toEqual(refused);
	expect(await f.head()).toBe(before);
	expect(await f.left()).toEqual({
		changed: '',
		staged: '',
		untracked: 'kept.md\ntoken.local',
	});
});

test('a *.local file Git already tracks is refused, naming the command that untracks it', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'token.local'), 'first\n');
	await gitIn(f.dir, 'add', '-f', 'token.local');
	await gitIn(f.dir, 'commit', '-qm', 'a token, committed by mistake');
	await writeFile(join(f.dir, 'token.local'), 'second\n');
	const before = await f.head();
	const message =
		'token.local would be committed: Git already tracks it, so notes/.gitignore cannot keep it out';
	const commit = `git -C ${f.dir} commit -m "notes: stop tracking token.local"`;
	expect(await snapshot('notes', f.dir)).toEqual({
		failed: {
			message,
			next: `git -C ${f.dir} rm --cached -- token.local && ${commit}`,
		},
	});
	expect(await f.head()).toBe(before);
	// Out of the index, it is still refused: a commit here would take its bytes again.
	await gitIn(f.dir, 'rm', '-q', '--cached', '--', 'token.local');
	expect(await snapshot('notes', f.dir)).toEqual({
		failed: { message, next: commit },
	});
	expect(await f.head()).toBe(before);
	await gitIn(f.dir, 'commit', '-q', '-m', 'notes: stop tracking token.local');
	expect(await snapshot('notes', f.dir)).toEqual({ committed: null });
	expect(await gitIn(f.dir, 'ls-files', 'token.local')).toBe('');
	expect(await readFile(join(f.dir, 'token.local'), 'utf8')).toBe('second\n');
});

test("a call holds the app's lock from its first write to its commit: sync waits for it, or says it is busy", async () => {
	const f = await setup();
	gate = Promise.withResolvers<void>();
	const running = f.run('pause', 'monday');
	while (!(await Bun.file(join(f.dir, 'monday.md')).exists()))
		await Bun.sleep(5);
	expect((await syncOne('notes', f.dir, { wait: 0 })).error).toEqual({
		message: 'notes: a call is still writing it',
		busy: true,
	});
	const waiting = syncOne('notes', f.dir);
	gate.resolve();
	expect((await running).committed).toEqual({
		committed: { subject: 'notes: pause monday', files: 2 },
	});
	expect(await waiting).toMatchObject({ committed: null, pushed: false });
	expect(await f.message()).toBe('notes: pause monday');
});

test("a call's first write waits while another process holds the app's lock, and one killed holding it holds nothing", async () => {
	const f = await setup();
	const holder = (ms: number) =>
		Bun.spawn(
			[
				process.execPath,
				'-e',
				`const { hold } = await import(${JSON.stringify(join(import.meta.dir, 'lock.ts'))}); await hold(${JSON.stringify(f.dir)}, 0); console.log('held'); await Bun.sleep(${ms});`,
			],
			{ stdout: 'pipe' },
		);
	const held = async (child: ReturnType<typeof holder>) =>
		expect(
			new TextDecoder().decode((await child.stdout.getReader().read()).value),
		).toBe('held\n');

	const brief = holder(300);
	await held(brief);
	const started = Date.now();
	expect((await f.run('write', 'monday')).committed).toEqual({
		committed: { subject: 'notes: write monday', files: 1 },
	});
	expect(Date.now() - started).toBeGreaterThanOrEqual(200);

	const killed = holder(3_600_000);
	await held(killed);
	killed.kill('SIGKILL');
	await killed.exited;
	const again = Date.now();
	expect((await f.run('write', 'tuesday')).committed).toEqual({
		committed: { subject: 'notes: write tuesday', files: 1 },
	});
	expect(Date.now() - again).toBeLessThan(1_000);
	const unblocked = await hold(f.dir, 0);
	expect(unblocked).toBeDefined();
	unblocked?.release();
});

test("snapshots from several processes, each holding the app's lock, commit what is pending once, and none fails", async () => {
	const f = await setup();
	for (const page of ['b', 'c', 'd'])
		await writeFile(join(f.dir, `${page}.md`), page);
	const dir = JSON.stringify(f.dir);
	// As every caller does: `snapshot` runs inside the app's lock.
	const script = `const { snapshot } = await import(${JSON.stringify(join(import.meta.dir, 'snapshot.ts'))}); const { locked, LOCK_WAIT_MS } = await import(${JSON.stringify(join(import.meta.dir, 'lock.ts'))}); const held = await locked(${dir}, LOCK_WAIT_MS, () => snapshot('notes', ${dir})); console.log(JSON.stringify('done' in held ? held.done : held));`;
	const answers = await Promise.all(
		Array.from({ length: 6 }, async () => {
			const child = Bun.spawn([process.execPath, '-e', script], {
				stdout: 'pipe',
				stderr: 'inherit',
			});
			await child.exited;
			return JSON.parse(await new Response(child.stdout).text());
		}),
	);
	expect(answers.filter((answer) => 'failed' in answer)).toEqual([]);
	expect(answers.filter((answer) => answer.committed !== null)).toEqual([
		{ committed: { subject: 'notes: changed outside epicenter', files: 3 } },
	]);
	expect(await gitIn(f.dir, 'log', '--format=%s')).toBe(
		'notes: changed outside epicenter\ninitial',
	);
});
