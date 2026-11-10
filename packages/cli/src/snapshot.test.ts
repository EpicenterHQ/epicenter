/**
 * A run commits nothing; a snapshot commits what is pending, named by the
 * calls logged since the last one (ADR-0850). In process, against a real
 * repository in a temporary folder.
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
import { historyOf, snapshot } from './snapshot.ts';

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
};

/** The notes app in a new repository with one commit, as the runner finds it. */
async function setup() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-snap-')));
	roots.push(dir);
	await writeFile(join(dir, 'a.md'), 'a\n');
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
	return { dir, run, head, message };
}

test('a run that returns commits nothing; the snapshot after it is named for the call', async () => {
	const f = await setup();
	const before = await f.head();
	expect(await f.run('write', 'monday')).toEqual({ returned: 'monday' });
	expect(await f.head()).toBe(before);
	expect(await gitIn(f.dir, 'status', '--porcelain')).toBe('?? monday.md');
	expect(await historyOf(f.dir)).toEqual({ pending: 1 });
	expect(await snapshot('notes', f.dir)).toEqual({
		committed: { subject: 'notes: write monday', files: 1 },
	});
	expect(await f.message()).toBe('notes: write monday');
	expect(await snapshot('notes', f.dir)).toEqual({ committed: null });
	expect(await historyOf(f.dir)).toEqual({ pending: 0 });
});

test('a run that throws after writing commits nothing, and the next snapshot takes its writes', async () => {
	const f = await setup();
	const before = await f.head();
	expect(await f.run('half', 'tuesday')).toEqual({
		threw: { message: 'stopped halfway' },
	});
	expect(await f.head()).toBe(before);
	expect(await readFile(join(f.dir, 'tuesday.md'), 'utf8')).toBe('tuesday');
	await f.run('write', 'wednesday');
	await writeFile(join(f.dir, 'a.md'), 'by hand\n');
	expect(await snapshot('notes', f.dir)).toEqual({
		committed: { subject: 'notes: 3 changes', files: 3 },
	});
	expect(await f.message()).toBe(
		'notes: 3 changes\n\nnotes: half tuesday\nnotes: write wednesday\nChanged outside epicenter: a.md',
	);
});

test('a call whose changes are already in history names no later snapshot', async () => {
	const f = await setup();
	await f.run('write', 'monday');
	await gitIn(f.dir, 'add', '-A');
	await gitIn(f.dir, 'commit', '-q', '-m', 'by hand');
	await writeFile(join(f.dir, 'b.md'), 'b\n');
	await snapshot('notes', f.dir);
	expect(await f.message()).toBe(
		'notes: 1 change\n\nChanged outside epicenter: b.md',
	);
});

test('concurrent snapshots of one folder in one process take turns', async () => {
	const f = await setup();
	await f.run('write', 'monday');
	const [first, second] = await Promise.all([
		snapshot('notes', f.dir),
		snapshot('notes', f.dir),
	]);
	expect(first).toEqual({
		committed: { subject: 'notes: write monday', files: 1 },
	});
	expect(second).toEqual({ committed: null });
});
