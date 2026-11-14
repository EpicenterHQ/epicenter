/**
 * A call snapshots pending data before its first write and commits everything
 * pending when it ends, holding the lock throughout. Other snapshots commit an
 * outside change (ADR-0850). The app code and data have separate repositories
 * (ADR-0877). Status names a repository with no backup and one whose backup
 * has never received its branch. In process, against real temporary repos.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Action,
	defineAction,
	defineApp,
	field,
	folder,
} from '@epicenter/app';
import { codeCommitOf, codeStateOf } from './data.ts';
import { folderOnDisk } from './disk.ts';
import type { Runnable } from './home.ts';
import { hold } from './lock.ts';
import { runAction } from './run.ts';
import { gitIn } from './runner.test-support.ts';
import { nothingToBackUp, snapshotApp, statusOf } from './snapshot.ts';
import { syncOne } from './sync.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

test('backup skips clean repositories but takes pending data and never-pushed branches', async () => {
	const f = await setup();
	expect(await nothingToBackUp(f.dir)).toBe(true);
	await writeFile(join(f.data, 'pending.md'), 'pending');
	expect(await nothingToBackUp(f.dir)).toBe(false);
	await snapshotApp('notes', f.dir);
	expect(await nothingToBackUp(f.dir)).toBe(true);
	await gitIn(f.data, 'remote', 'add', 'origin', join(f.dir, 'backup.git'));
	expect(await nothingToBackUp(f.dir)).toBe(false);
});

test('backup takes data that has no repository of its own yet', async () => {
	const f = await setup();
	await rm(join(f.data, '.git'), { recursive: true });
	expect(await nothingToBackUp(f.dir)).toBe(false);
});

/** What `pause` waits for between its writes; each test that runs it makes a new one. */
let gate = Promise.withResolvers<void>();

const actions = {
	write: defineAction({
		description: 'Write a page',
		input: { page: field.text() },
		positional: ['page'],
		run: async ({ page }) => {
			await folder.write(`data/${page}.md`, page);
			return page;
		},
	}),
	half: defineAction({
		description: 'Write a page, then throw',
		input: { page: field.text() },
		positional: ['page'],
		run: async ({ page }) => {
			await folder.write(`data/${page}.md`, page);
			throw new Error('stopped halfway');
		},
	}),
	pause: defineAction({
		description: 'Write a page, wait for the gate, then write another',
		input: { page: field.text() },
		positional: ['page'],
		run: async ({ page }) => {
			await folder.write(`data/${page}.md`, page);
			await gate.promise;
			await folder.write(`data/${page}-after.md`, page);
		},
	}),
	scratch: defineAction({
		description: 'Write a page, and paths no commit takes',
		input: { page: field.text() },
		positional: ['page'],
		run: async ({ page }) => {
			await folder.write(`data/${page}.md`, page);
			await folder.write('data/gone.md', 'gone');
			await folder.delete('data/gone.md');
			await folder.write('data/node_modules/seen.txt', page);
			await folder.write('data/token.local', 'secret');
		},
	}),
};

/** The notes app in a new repository with one commit, as the runner finds it. */
async function setup() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-snap-')));
	roots.push(dir);
	await mkdir(join(dir, 'data'));
	await writeFile(join(dir, 'data/a.md'), 'a\n');
	await writeFile(join(dir, '.gitignore'), 'data/\nnode_modules/\n');
	await gitIn(dir, 'init', '-q');
	await gitIn(dir, 'add', '-A');
	await gitIn(dir, 'commit', '-q', '-m', 'initial');
	const data = join(dir, 'data');
	await writeFile(join(data, '.gitignore'), '*.local\n*.local.*\n');
	await gitIn(data, 'init', '-q');
	await gitIn(data, 'add', '-A');
	await gitIn(data, 'commit', '-q', '-m', 'notes: start its data');
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
	const run = async (key: keyof typeof actions, page: string) =>
		runAction(
			located,
			key,
			actions[key] as Action,
			{ page },
			await codeStateOf(dir),
		);
	const head = () => gitIn(data, 'rev-parse', 'HEAD');
	const message = () => gitIn(data, 'log', '-1', '--format=%B');
	const files = () => gitIn(data, 'show', '--name-only', '--format=', 'HEAD');
	/** What is left pending: changed, staged, and untracked paths. */
	const left = async () => ({
		changed: await gitIn(data, 'diff', '--name-only'),
		staged: await gitIn(data, 'diff', '--cached', '--name-only'),
		untracked: await gitIn(data, 'ls-files', '--others', '--exclude-standard'),
	});
	return { dir, data, located, run, head, message, files, left };
}

test('a call commits what it wrote, named for the call, before it answers', async () => {
	const f = await setup();
	const run = await f.run('write', 'monday');
	expect(run).toEqual({
		answer: { returned: 'monday' },
		committed: { committed: { subject: 'notes: write monday', files: 1 } },
	});
	expect(await f.message()).toContain('notes: write monday');
	expect(await f.files()).toBe('monday.md');
	expect(await snapshotApp('notes', f.dir)).toEqual({
		code: { committed: null },
		data: { committed: null },
	});
	expect(await statusOf(f.data)).toEqual({ pending: 0, backup: 'none' });
});

test('a data commit names the code HEAD it was written under', async () => {
	const f = await setup();
	const codeHead = await gitIn(f.dir, 'rev-parse', 'HEAD');
	expect((await f.run('write', 'monday')).committed).toEqual({
		committed: { subject: 'notes: write monday', files: 1 },
	});
	expect(await gitIn(f.data, 'log', '-1', '--format=%B')).toBe(
		`notes: write monday\n\nCode-Commit: ${codeHead}`,
	);
	expect(await gitIn(f.dir, 'rev-parse', 'HEAD')).toBe(codeHead);
});

test('a code snapshot refuses when .gitignore does not list data and leaves code uncommitted', async () => {
	const f = await setup();
	const codeHead = await gitIn(f.dir, 'rev-parse', 'HEAD');
	await writeFile(join(f.dir, '.gitignore'), 'node_modules/\n');
	await writeFile(join(f.dir, 'new.ts'), 'export const changed = true;\n');
	const taken = await snapshotApp('notes', f.dir);
	expect(taken.code).toEqual({
		failed: {
			message:
				'notes/.gitignore does not list data/, so a commit of the code could take the data',
			next: `printf 'data/\n' >> ${join(f.dir, '.gitignore')}`,
		},
	});
	expect(await gitIn(f.dir, 'rev-parse', 'HEAD')).toBe(codeHead);
	expect(await gitIn(f.dir, 'diff', '--cached', '--name-only')).toBe('');
});

test('status names an origin that has never received the branch, and counts once it has', async () => {
	const f = await setup();
	const backup = join(f.dir, 'backup.git');
	await gitIn(f.data, 'init', '-q', '--bare', backup);
	await gitIn(f.data, 'remote', 'add', 'origin', backup);
	expect(await statusOf(f.data)).toEqual({ pending: 0, backup: 'never' });
	const branch = await gitIn(f.data, 'symbolic-ref', '--short', 'HEAD');
	await gitIn(f.data, 'push', '-q', 'origin', `HEAD:${branch}`);
	expect(await statusOf(f.data)).toEqual({ pending: 0, unpushed: 0 });
});

test('pending hand edits and staged data get a snapshot before the call', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'data/a.md'), 'by hand\n');
	await writeFile(join(f.dir, 'data/staged.md'), 'staged\n');
	await gitIn(f.data, 'add', 'staged.md');
	// A path is a path, never a pattern: `star*.md` does not take `stars.md`.
	await writeFile(join(f.dir, 'stars.md'), 'by hand\n');
	expect((await f.run('write', 'star*')).committed).toEqual({
		committed: { subject: 'notes: write star*', files: 1 },
	});
	expect(await f.message()).toContain('notes: write star*');
	expect(await f.files()).toBe('star*.md');
	expect(await f.left()).toEqual({
		changed: '',
		staged: '',
		untracked: '',
	});
	expect(await gitIn(f.dir, 'ls-files', '--others', '--exclude-standard')).toBe(
		'stars.md',
	);
	expect(await gitIn(f.data, 'log', '--format=%s', '-3')).toBe(
		'notes: write star*\nnotes: changed outside epicenter\nnotes: start its data',
	);
	expect(await gitIn(f.data, 'show', '--name-only', '--format=', 'HEAD~')).toBe(
		'a.md\nstaged.md',
	);
});

test('a run that throws after writing commits its writes as the call that threw', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'data/a.md'), 'by hand\n');
	const run = await f.run('half', 'tuesday');
	expect(run.answer).toEqual({ threw: { message: 'stopped halfway' } });
	expect(await readFile(join(f.dir, 'data/tuesday.md'), 'utf8')).toBe(
		'tuesday',
	);
	expect(run.committed).toEqual({
		committed: { subject: 'notes: half tuesday (threw)', files: 1 },
	});
	expect(await f.message()).toContain('notes: half tuesday (threw)');
	expect(await f.files()).toBe('tuesday.md');
	expect(await f.left()).toEqual({
		changed: '',
		staged: '',
		untracked: '',
	});
});

test('a call skips deleted and local paths while committing other data paths', async () => {
	const f = await setup();
	// It wrote data/node_modules/seen.txt, data/gone.md, data/kept.md, and data/token.local.
	expect((await f.run('scratch', 'kept')).committed).toEqual({
		committed: { subject: 'notes: scratch kept', files: 2 },
	});
	expect(await f.files()).toBe('kept.md\nnode_modules/seen.txt');
	const before = await f.head();
	// The same call again changes nothing it would take, so it commits nothing.
	expect((await f.run('scratch', 'kept')).committed).toEqual({
		committed: null,
	});
	expect(await f.head()).toBe(before);
});

test('a snapshot with no call takes everything pending, named changed outside epicenter or by its message', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'data/b.md'), 'b\n');
	await snapshotApp('notes', f.dir);
	expect(await f.message()).toContain('notes: changed outside epicenter');
	expect(await f.files()).toBe('b.md');
	await writeFile(join(f.dir, 'data/a.md'), 'tidied\n');
	await writeFile(join(f.dir, 'data/c.md'), 'c\n');
	expect(await snapshotApp('notes', f.dir, 'tidy the pages')).toEqual({
		code: { committed: null },
		data: { committed: { subject: 'notes: tidy the pages', files: 2 } },
	});
	expect(await f.message()).toContain('notes: tidy the pages');
	expect(await f.files()).toBe('a.md\nc.md');
});

test('snapshot refuses a revert in progress without staging or committing', async () => {
	const f = await setup();
	const before = await f.head();
	const gitPath = await gitIn(f.data, 'rev-parse', '--git-path', 'REVERT_HEAD');
	await writeFile(join(f.data, gitPath), `${before}\n`);
	await writeFile(join(f.dir, 'data/pending.md'), 'pending\n');
	expect(await snapshotApp('notes', f.dir)).toEqual({
		code: { committed: null },
		data: {
			failed: {
				message: expect.stringContaining(
					'middle of a merge, rebase, revert, or cherry-pick',
				),
				next: `git -C ${f.data} status`,
			},
		},
	});
	expect(await f.head()).toBe(before);
	expect(await gitIn(f.data, 'diff', '--cached', '--name-only')).toBe('');
	expect(await gitIn(f.data, 'status', '--porcelain')).toContain(
		'?? pending.md',
	);
});

test('a *.local file the .gitignore lets through is refused before anything is staged', async () => {
	const f = await setup();
	await writeFile(join(f.data, '.gitignore'), 'node_modules/\n');
	await gitIn(f.data, 'commit', '-qam', 'no *.local in .gitignore');
	const before = await f.head();
	const refused = {
		failed: {
			message:
				'token.local would be committed; add *.local and *.local.* to notes/data/.gitignore',
		},
	};
	expect((await f.run('scratch', 'kept')).committed).toEqual(refused);
	expect(await snapshotApp('notes', f.dir)).toEqual({
		code: { committed: null },
		data: refused,
	});
	expect(await f.head()).toBe(before);
	expect(await f.left()).toEqual({
		changed: '',
		staged: '',
		untracked: 'kept.md\ntoken.local',
	});
});

test('a *.local file Git already tracks is refused, naming the command that untracks it', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'data/token.local'), 'first\n');
	await gitIn(f.data, 'add', '-f', 'token.local');
	await gitIn(f.data, 'commit', '-qm', 'a token, committed by mistake');
	await writeFile(join(f.dir, 'data/token.local'), 'second\n');
	const before = await f.head();
	const message =
		'token.local would be committed: Git already tracks it, so notes/data/.gitignore cannot keep it out';
	const commit = `git -C ${f.data} commit -m "notes: stop tracking token.local"`;
	expect(await snapshotApp('notes', f.dir)).toEqual({
		code: { committed: null },
		data: {
			failed: {
				message,
				next: `git -C ${f.data} rm --cached -- token.local && ${commit}`,
			},
		},
	});
	expect(await f.head()).toBe(before);
	// Out of the index, it is still refused: a commit here would take its bytes again.
	await gitIn(f.data, 'rm', '-q', '--cached', '--', 'token.local');
	expect(await snapshotApp('notes', f.dir)).toEqual({
		code: { committed: null },
		data: { failed: { message, next: commit } },
	});
	expect(await f.head()).toBe(before);
	await gitIn(f.data, 'commit', '-q', '-m', 'notes: stop tracking token.local');
	expect(await snapshotApp('notes', f.dir)).toEqual({
		code: { committed: null },
		data: { committed: null },
	});
	expect(await gitIn(f.data, 'ls-files', 'token.local')).toBe('');
	expect(await readFile(join(f.dir, 'data/token.local'), 'utf8')).toBe(
		'second\n',
	);
});

test("a call holds the app's lock from its first write to its commit: sync waits for it, or says it is busy", async () => {
	const f = await setup();
	gate = Promise.withResolvers<void>();
	const running = f.run('pause', 'monday');
	while (!(await Bun.file(join(f.dir, 'data/monday.md')).exists()))
		await Bun.sleep(5);
	expect(await syncOne('notes', f.dir, { wait: 0 })).toMatchObject({
		busy: true,
		code: null,
		data: null,
	});
	const waiting = syncOne('notes', f.dir);
	gate.resolve();
	expect((await running).committed).toEqual({
		committed: { subject: 'notes: pause monday', files: 2 },
	});
	expect(await waiting).toMatchObject({
		code: { committed: null, pushed: false },
		data: { committed: null, pushed: false },
	});
	expect(await f.message()).toContain('notes: pause monday');
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
		await writeFile(join(f.data, `${page}.md`), page);
	const dir = JSON.stringify(f.dir);
	// As every caller does: `snapshot` runs inside the app's lock.
	const script = `const { snapshotApp } = await import(${JSON.stringify(join(import.meta.dir, 'snapshot.ts'))}); const { locked, LOCK_WAIT_MS } = await import(${JSON.stringify(join(import.meta.dir, 'lock.ts'))}); const held = await locked(${dir}, LOCK_WAIT_MS, () => snapshotApp('notes', ${dir})); console.log(JSON.stringify('done' in held ? held.done : held));`;
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
	expect(answers.filter((answer) => 'failed' in answer.data)).toEqual([]);
	expect(answers.filter((answer) => answer.data.committed !== null)).toEqual([
		{
			code: { committed: null },
			data: {
				committed: { subject: 'notes: changed outside epicenter', files: 3 },
			},
		},
	]);
	expect(await gitIn(f.data, 'log', '--format=%s')).toBe(
		'notes: changed outside epicenter\nnotes: start its data',
	);
});

test('writes outside folder after the first write belong to the call', async () => {
	const f = await setup();
	gate = Promise.withResolvers<void>();
	const running = f.run('pause', 'monday');
	while (!(await Bun.file(join(f.data, 'monday.md')).exists()))
		await Bun.sleep(5);
	await writeFile(join(f.data, 'by-library.md'), 'library');
	gate.resolve();
	expect((await running).committed).toEqual({
		committed: { subject: 'notes: pause monday', files: 3 },
	});
	expect(await f.files()).toBe('by-library.md\nmonday-after.md\nmonday.md');
});

test('concurrent first writes take the lock once', async () => {
	const f = await setup();
	const action = defineAction({
		description: 'Write concurrently',
		input: {},
		run: () =>
			Promise.all([
				folder.write('data/one.md', 'one'),
				folder.write('data/two.md', 'two'),
			]),
	});
	const ran = await runAction(
		f.located,
		'pair',
		action,
		{},
		await codeStateOf(f.dir),
	);
	expect(ran.answer).toHaveProperty('returned');
	expect(ran.committed).toEqual({
		committed: { subject: 'notes: pair', files: 2 },
	});
});

test('a call with no folder write takes no lock and leaves hand edits pending', async () => {
	const f = await setup();
	await writeFile(join(f.data, 'a.md'), 'pending');
	const held = await hold(f.dir, 0);
	expect(held).toBeDefined();
	try {
		const action = defineAction({
			description: 'Read',
			input: {},
			run: () => 'read',
		});
		expect(
			await runAction(f.located, 'read', action, {}, await codeStateOf(f.dir)),
		).toEqual({ answer: { returned: 'read' } });
		expect((await f.left()).changed).toBe('a.md');
	} finally {
		held?.release();
	}
});

test('a read-only local write takes no lock and commits nothing', async () => {
	const f = await setup();
	const paused = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const before = await f.head();
	const action = defineAction({
		description: 'Refresh',
		input: {},
		annotations: { readOnlyHint: true },
		run: async () => {
			await folder.write('data/token.local', 'secret');
			paused.resolve();
			await resume.promise;
		},
	});
	const running = runAction(
		f.located,
		'refresh',
		action,
		{},
		await codeStateOf(f.dir),
	);
	await paused.promise;
	try {
		expect(await syncOne('notes', f.dir, { wait: 0 })).not.toHaveProperty(
			'busy',
		);
	} finally {
		resume.resolve();
	}
	expect(await running).toEqual({ answer: { returned: null } });
	expect(await f.head()).toBe(before);
});

test('an opening snapshot failure never gives pre-existing edits the call name', async () => {
	const f = await setup();
	await writeFile(join(f.data, '.gitignore'), '');
	await writeFile(join(f.data, 'token.local'), 'secret');
	const before = await f.head();
	const ran = await f.run('write', 'monday');
	expect(ran.answer).toEqual({ returned: 'monday' });
	expect(ran.committed).toHaveProperty('failed');
	expect(await f.head()).toBe(before);
	expect((await f.left()).untracked).toBe('monday.md\ntoken.local');
});

test('a data commit carries Code-Dirty when the captured code is uncommitted', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'changed.ts'), 'export const changed = true;');
	const head = await gitIn(f.dir, 'rev-parse', 'HEAD');
	await f.run('write', 'monday');
	expect(await f.message()).toBe(
		`notes: write monday\n\nCode-Commit: ${head}\nCode-Dirty: true`,
	);
	expect(codeCommitOf(await f.message())).toBe(head);
});

test('a data commit names the code captured before HEAD moves during the action', async () => {
	const f = await setup();
	const before = await gitIn(f.dir, 'rev-parse', 'HEAD');
	gate = Promise.withResolvers<void>();
	const running = f.run('pause', 'monday');
	while (!(await Bun.file(join(f.data, 'monday.md')).exists()))
		await Bun.sleep(5);
	await writeFile(join(f.dir, 'changed.ts'), 'export const changed = true;');
	await gitIn(f.dir, 'add', 'changed.ts');
	await gitIn(f.dir, 'commit', '-qm', 'changed code');
	gate.resolve();
	await running;
	expect(await f.message()).toBe(
		`notes: pause monday\n\nCode-Commit: ${before}`,
	);
	expect(await gitIn(f.dir, 'rev-parse', 'HEAD')).not.toBe(before);
});
