/**
 * A run commits nothing; a call's commit holds exactly the paths its run
 * reported, and a snapshot with no call commits what is pending as an outside
 * change (ADR-0850). In process, against a real repository in a temporary
 * folder.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Action,
	createMemoryContext,
	defineAction,
	defineApp,
	field,
	folder,
} from '@epicenter/app';
import { folderOnDisk } from './disk.ts';
import type { Runnable } from './home.ts';
import { runAction } from './run.ts';
import { gitIn } from './runner.test-support.ts';
import { snapshot, statusOf, type Wrote } from './snapshot.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

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
	scratch: defineAction({
		description: 'Write a page, and paths no commit takes',
		input: { page: field.text() },
		positional: ['page'],
		run: async ({ page }) => {
			await folder.write(`${page}.md`, page);
			await folder.write('gone.md', 'gone');
			await folder.delete('gone.md');
			await folder.write('.cache/seen.txt', page);
			await folder.write('token.local', 'secret');
		},
	}),
};

/** The notes app in a new repository with one commit, as the runner finds it. */
async function setup() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-snap-')));
	roots.push(dir);
	await writeFile(join(dir, 'a.md'), 'a\n');
	await writeFile(join(dir, '.gitignore'), '.cache/\n*.local\n*.local.*\n');
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
		context: {
			folder: folderOnDisk(dir),
			secrets: createMemoryContext().secrets,
		},
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
	/** Commit a run's writes, as the command line and `serve` do after it. */
	const commit = ({ wrote }: { wrote?: Wrote }) => {
		if (!wrote) throw new Error('a write run reports what it wrote');
		return snapshot('notes', dir, { wrote });
	};
	return { dir, run, head, message, files, left, commit };
}

test('a run that returns commits nothing; the commit after it is named for the call', async () => {
	const f = await setup();
	const before = await f.head();
	const run = await f.run('write', 'monday');
	expect(run.answer).toEqual({ returned: 'monday' });
	expect(run.wrote).toEqual({
		call: 'notes: write monday',
		paths: ['monday.md'],
	});
	expect(await f.head()).toBe(before);
	expect(await gitIn(f.dir, 'status', '--porcelain')).toBe('?? monday.md');
	expect(await statusOf(f.dir)).toEqual({ pending: 1 });
	expect(await f.commit(run)).toEqual({
		committed: { subject: 'notes: write monday', files: 1 },
	});
	expect(await f.message()).toBe('notes: write monday');
	expect(await snapshot('notes', f.dir)).toEqual({ committed: null });
	expect(await statusOf(f.dir)).toEqual({ pending: 0 });
});

test("a call's commit holds only its paths; a hand edit and a staged file stay pending", async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'a.md'), 'by hand\n');
	await writeFile(join(f.dir, 'staged.md'), 'staged\n');
	await gitIn(f.dir, 'add', 'staged.md');
	// A path is a path, never a pattern: `star*.md` does not take `stars.md`.
	await writeFile(join(f.dir, 'stars.md'), 'by hand\n');
	expect(await f.commit(await f.run('write', 'star*'))).toEqual({
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
	expect(await f.commit(run)).toEqual({
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
	const run = await f.run('scratch', 'kept');
	expect(run.wrote?.paths).toEqual([
		'.cache/seen.txt',
		'gone.md',
		'kept.md',
		'token.local',
	]);
	expect(await f.commit(run)).toEqual({
		committed: { subject: 'notes: scratch kept', files: 1 },
	});
	expect(await f.files()).toBe('kept.md');
	await rm(join(f.dir, 'kept.md'));
	await gitIn(f.dir, 'commit', '-qam', 'no kept');
	const before = await f.head();
	await rm(join(f.dir, 'token.local'));
	const none = await f.run('scratch', 'kept');
	await rm(join(f.dir, 'kept.md'));
	expect(await f.commit(none)).toEqual({ committed: null });
	expect(await f.head()).toBe(before);
});

test('a snapshot with no call takes everything pending, named changed outside epicenter or by its message', async () => {
	const f = await setup();
	await f.run('write', 'monday');
	await gitIn(f.dir, 'add', '-A');
	await gitIn(f.dir, 'commit', '-q', '-m', 'by hand');
	await writeFile(join(f.dir, 'b.md'), 'b\n');
	await snapshot('notes', f.dir);
	expect(await f.message()).toBe(
		'notes: changed outside epicenter\n\nChanged:\nb.md',
	);
	await writeFile(join(f.dir, 'a.md'), 'tidied\n');
	await writeFile(join(f.dir, 'c.md'), 'c\n');
	expect(await snapshot('notes', f.dir, { message: 'tidy the pages' })).toEqual(
		{ committed: { subject: 'notes: tidy the pages', files: 2 } },
	);
	expect(await f.message()).toBe(
		'notes: tidy the pages\n\nChanged:\na.md\nc.md',
	);
});

test('snapshot refuses a revert in progress without staging or committing', async () => {
	const f = await setup();
	const before = await f.head();
	const gitPath = await gitIn(f.dir, 'rev-parse', '--git-path', 'REVERT_HEAD');
	await writeFile(join(f.dir, gitPath), `${before}\n`);
	await writeFile(join(f.dir, 'pending.md'), 'pending\n');
	expect(await snapshot('notes', f.dir)).toEqual({
		failed: expect.stringContaining(
			'middle of a merge, rebase, revert, or cherry-pick',
		),
	});
	expect(await f.head()).toBe(before);
	expect(await gitIn(f.dir, 'diff', '--cached', '--name-only')).toBe('');
	expect(await gitIn(f.dir, 'status', '--porcelain')).toContain(
		'?? pending.md',
	);
});

test('snapshot body keeps comma and newline paths as separate paths', async () => {
	const f = await setup();
	await writeFile(join(f.dir, 'a,b.md'), 'comma\n');
	await writeFile(join(f.dir, 'line\nbreak.md'), 'newline\n');
	expect(await snapshot('notes', f.dir)).toEqual({
		committed: { subject: 'notes: changed outside epicenter', files: 2 },
	});
	expect(await f.message()).toBe(
		'notes: changed outside epicenter\n\nChanged:\na,b.md\n"line\\nbreak.md"',
	);
});

test('a *.local file the .gitignore lets through is refused before anything is staged', async () => {
	const f = await setup();
	await writeFile(join(f.dir, '.gitignore'), '.cache/\n');
	await gitIn(f.dir, 'commit', '-qam', 'no *.local in .gitignore');
	const before = await f.head();
	const refused = {
		failed:
			'token.local would be committed; add *.local and *.local.* to notes/.gitignore',
	};
	expect(await f.commit(await f.run('scratch', 'kept'))).toEqual(refused);
	expect(await snapshot('notes', f.dir)).toEqual(refused);
	expect(await f.head()).toBe(before);
	expect(await f.left()).toEqual({
		changed: '',
		staged: '',
		untracked: 'kept.md\ntoken.local',
	});
});

test('concurrent snapshots of one folder in one process take turns', async () => {
	const f = await setup();
	const run = await f.run('write', 'monday');
	const [first, second] = await Promise.all([
		f.commit(run),
		snapshot('notes', f.dir),
	]);
	expect(first).toEqual({
		committed: { subject: 'notes: write monday', files: 1 },
	});
	expect(second).toEqual({ committed: null });
});
