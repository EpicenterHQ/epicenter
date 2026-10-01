/**
 * Index Reconciliation Tests
 *
 * A whole-folder checkpoint builds its commit without the shared index, then
 * resets every index entry to the resulting head with real `git reset`. These
 * tests drive real native Git into staging states that a path-by-path sync
 * would miss.
 *
 * Key behaviors:
 * - HEAD and files at B with the index at A (`git status` MM) end clean
 * - Staged-only additions (including force-added ignored files) and staged-only
 *   deletions are superseded by the checkpoint instead of surviving it
 * - An index lock after a successful branch update keeps the commit and
 *   reports `indexWarning`; a later explicit commit-and-push repairs the index
 *
 * See also:
 * - `native.test.ts` for automatic commits and the browser/native exchange
 * - `source-scope.test.ts` for which files a checkpoint includes
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineStore, defineTable, field } from '../index.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';
import { openNativeFolder } from './native.js';

const definition = defineStore({
	id: 'so.epicenter.todostest',
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const author = { name: 'App', email: 'app@example.test' };
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});

async function repository() {
	const root = await scratch('index-reconcile-');
	await git(root, 'init', '--quiet', '--initial-branch=main');
	await writeFile(join(root, 'a.md'), 'A\n');
	await writeFile(join(root, 'kept.md'), 'kept\n');
	await git(root, 'add', '--all');
	await git(root, 'commit', '--quiet', '-m', 'Start');
	return root;
}

test('an unchanged checkpoint repairs HEAD B, files B, index A (MM)', async () => {
	const root = await repository();
	await writeFile(join(root, 'a.md'), 'B\n');
	await git(root, 'commit', '--quiet', '-am', 'B');
	await git(root, 'reset', '--quiet', 'HEAD~1', '--', 'a.md');
	expect(await git(root, 'status', '--porcelain')).toBe('MM a.md');

	const folder = await openNativeFolder({
		root,
		definition,
		git: { author, commitOnEdit: false },
	});
	const outcome = await folder.git.commit();
	expect(outcome).toMatchObject({
		status: 'unchanged',
		indexWarning: undefined,
	});
	expect(await git(root, 'status', '--porcelain')).toBe('');
	expect(await git(root, 'log', '--format=%s')).toBe('B\nStart');
	await folder.close();
});

test('staged-only additions and deletions do not survive a checkpoint', async () => {
	const root = await repository();
	await writeFile(join(root, '.gitignore'), '*.log\n');
	await git(root, 'add', '.gitignore');
	await git(root, 'commit', '--quiet', '-m', 'Ignore logs');
	await writeFile(join(root, 'debug.log'), 'noise\n');
	await git(root, 'add', '--force', 'debug.log');
	await git(root, 'rm', '--quiet', '--cached', 'kept.md');
	const staged = await git(root, 'status', '--porcelain');
	expect(staged).toContain('A  debug.log');
	expect(staged).toContain('D  kept.md');

	const folder = await openNativeFolder({
		root,
		definition,
		git: { author, commitOnEdit: false },
	});
	const outcome = await folder.git.commit();
	// The ignored file is not source, and kept.md is unchanged: no new commit.
	expect(outcome.status).toBe('unchanged');
	expect(await git(root, 'status', '--porcelain')).toBe('');
	expect(await git(root, 'ls-files')).toBe('.gitignore\na.md\nkept.md');
	await folder.close();
});

test('an index lock after the branch moved keeps the commit and a later commit-and-push repairs the index', async () => {
	const root = await repository();
	const folder = await openNativeFolder({
		root,
		definition,
		git: { author, commitOnEdit: false },
	});
	await folder.files.write('b.md', 'new\n', { expected: 'absent' });
	await writeFile(join(root, '.git', 'index.lock'), '');
	const locked = await folder.git.commit();
	expect(locked.status).toBe('committed');
	if (locked.status !== 'committed') throw new Error('expected a commit');
	expect(locked.indexWarning).toContain('index.lock');
	expect(await git(root, 'rev-parse', 'HEAD')).toBe(locked.oid);

	await rm(join(root, '.git', 'index.lock'));
	// The unrepaired index shows the committed file as a staged deletion.
	expect(await git(root, 'status', '--porcelain')).toContain('D  b.md');
	const repaired = await folder.git.commitAndPush();
	expect(repaired.commit).toMatchObject({
		status: 'unchanged',
		indexWarning: undefined,
	});
	expect(repaired.push.status).toBe('noRemote');
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await folder.close();
});
