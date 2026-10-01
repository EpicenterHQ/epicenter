/**
 * History Source Scope Tests
 *
 * Status, automatic commits, and incoming fast-forwards share one inclusion
 * rule: tracked files stay source, untracked files are source unless
 * `.gitignore` excludes them, and the root generated `index.sqlite3` never is.
 *
 * Key behaviors:
 * - Root and nested `.gitignore` rules, negation, and ignored directories
 * - A tracked file stays tracked after a rule starts matching it
 * - Browser and native folders agree with `git status` about what is dirty
 * - A fast-forward preserves ignored files and refuses to overwrite one
 *
 * See also:
 * - `index-reconcile.test.ts` for staged-only intent after a checkpoint
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { defineStore, defineTable, field } from '../index.js';
import { gitignoreMatcher } from './git/scope.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';
import { type Folder, openBrowserFolder } from './index.js';
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

const encode = (text: string) => new TextEncoder().encode(text);

/** Files every scope test writes, relative to the folder root. */
const LAYOUT: Record<string, string> = {
	'.gitignore': '*.log\nbuild/\n',
	'notes/.gitignore': 'secret.txt\n!keep.log\n',
	'app.log': 'ignored at the root\n',
	'build/out.txt': 'inside an ignored directory\n',
	'notes/keep.log': 're-included by the nested file\n',
	'notes/secret.txt': 'ignored by the nested file\n',
	'notes/plain.txt': 'ordinary source\n',
	'index.sqlite3': 'generated query index\n',
};
const SOURCE = [
	'.gitignore',
	'notes/.gitignore',
	'notes/keep.log',
	'notes/plain.txt',
].sort();

async function writeLayout(folder: Folder<typeof definition>) {
	for (const [path, text] of Object.entries(LAYOUT))
		expect(
			(await folder.files.write(path, text, { expected: 'any' })).error,
		).toBeNull();
}

describe('gitignoreMatcher', () => {
	test('applies nested files, negation, and ignored directories', () => {
		const ignored = gitignoreMatcher(
			new Map(
				Object.entries(LAYOUT).map(([path, text]) => [path, encode(text)]),
			),
		);
		expect(
			Object.keys(LAYOUT)
				.filter((path) => !ignored(path))
				.sort(),
		).toEqual([...SOURCE, 'index.sqlite3'].sort());
	});
});

describe('browser folder scope', () => {
	test('status and commits exclude ignored files; tracked files stay tracked', async () => {
		const folder = await openBrowserFolder({
			id: 'scope',
			definition,
			git: { author, commitOnEdit: false },
			indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
		});
		// Committed before any rule matches it.
		await folder.files.write('tracked.log', 'v1\n', { expected: 'absent' });
		expect((await folder.git.commit()).status).toBe('committed');

		await writeLayout(folder);
		const status = await folder.git.status();
		expect(status.data?.changes.map((change) => change.path)).toEqual(SOURCE);

		await folder.files.write('tracked.log', 'v2\n', { expected: 'any' });
		expect(
			(await folder.git.status()).data?.changes.map((change) => change.path),
		).toEqual([...SOURCE, 'tracked.log'].sort());
		const outcome = await folder.git.commit();
		expect(outcome.status).toBe('committed');
		expect((await folder.git.status()).data?.changes).toEqual([]);
		// The terminal's `git status` keeps Git semantics: the generated index is
		// untracked (not ignored), exactly as native Git reports it.
		expect((await folder.git.paths()).data).toEqual([
			{ path: 'index.sqlite3', index: '?', worktree: '?' },
		]);
		await folder.close();
	});
});

describe('native folder scope', () => {
	test('agrees with git status and never commits ignored files', async () => {
		const root = await scratch('scope-native-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author, commitOnEdit: false },
		});
		await folder.files.write('tracked.log', 'v1\n', { expected: 'absent' });
		expect((await folder.git.commit()).status).toBe('committed');
		await writeLayout(folder);
		await folder.files.write('tracked.log', 'v2\n', { expected: 'any' });

		expect(
			(await folder.git.status()).data?.changes.map((change) => change.path),
		).toEqual([...SOURCE, 'tracked.log'].sort());
		const porcelain = (
			await git(root, 'status', '--porcelain', '--untracked-files=all')
		)
			.split('\n')
			.map((line) => line.replace(/^\S+\s+/, ''))
			.sort();
		// Native Git lists index.sqlite3; it is derived data, never history source.
		expect(porcelain).toEqual(
			[...SOURCE, 'index.sqlite3', 'tracked.log'].sort(),
		);

		expect((await folder.git.commit()).status).toBe('committed');
		expect((await git(root, 'ls-files')).split('\n').sort()).toEqual(
			[...SOURCE, 'tracked.log'].sort(),
		);
		expect(await git(root, 'status', '--porcelain')).toBe('?? index.sqlite3');
		await folder.close();
	});

	test('a fast-forward preserves ignored files and refuses to overwrite one', async () => {
		const root = await scratch('scope-pull-');
		const bare = join(root, 'remote.git');
		await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
		const writerRoot = join(root, 'writer');
		const readerRoot = join(root, 'reader');
		for (const path of [writerRoot, readerRoot])
			await git(root, 'init', '--quiet', '--initial-branch=main', path);
		const remote = { url: bare, branch: 'main' };
		const writer = await openNativeFolder({
			root: writerRoot,
			definition,
			git: { author, remote, commitOnEdit: false },
		});
		const reader = await openNativeFolder({
			root: readerRoot,
			definition,
			git: { author, remote, commitOnEdit: false },
		});

		await writer.files.write('.gitignore', '*.log\n', { expected: 'absent' });
		expect((await writer.git.commitAndPush()).push.status).toBe('pushed');
		await reader.git.fetch();
		expect((await reader.git.pullFastForward()).data?.status).toBe(
			'fastForwarded',
		);

		// Ignored local files do not make the reader dirty and survive updates.
		await writeFile(join(readerRoot, 'local.log'), 'reader only\n');
		await writeFile(join(readerRoot, 'shared.log'), 'reader copy\n');
		await writer.files.write('readme.md', 'hello\n', { expected: 'absent' });
		await writer.git.commitAndPush();
		await reader.git.fetch();
		expect((await reader.git.pullFastForward()).data?.status).toBe(
			'fastForwarded',
		);
		expect(await readFile(join(readerRoot, 'local.log'), 'utf8')).toBe(
			'reader only\n',
		);

		// The writer force-tracks a path the reader has as an ignored file.
		await writeFile(join(writerRoot, 'shared.log'), 'writer copy\n');
		await git(writerRoot, 'add', '--force', 'shared.log');
		await git(writerRoot, 'commit', '--quiet', '-m', 'Track shared.log');
		expect((await writer.git.push()).status).toBe('pushed');
		await reader.git.fetch();
		const collided = await reader.git.pullFastForward();
		expect(collided.error?.name).toBe('Collision');
		expect(await readFile(join(readerRoot, 'shared.log'), 'utf8')).toBe(
			'reader copy\n',
		);
		expect(await git(readerRoot, 'log', '-1', '--format=%s')).toBe(
			'Add readme.md',
		);
		await writer.close();
		await reader.close();
	});
});
