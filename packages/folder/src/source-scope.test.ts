/**
 * History Source Scope Tests
 *
 * Status, whole-folder commits, and incoming fast-forwards share one inclusion
 * rule on every host: tracked files stay source, untracked files are source
 * unless `.gitignore` excludes them, and an ignored untracked file is never
 * read (ADR-0592). SQLite filenames have no special source policy.
 *
 * Key behaviors:
 * - Root and nested `.gitignore` rules, negation, and ignored directories
 * - A tracked file stays tracked after a rule starts matching it
 * - Browser and native folders agree with `git status` about what is dirty
 * - A fast-forward preserves ignored files and refuses to overwrite one
 * - Status and commits decide ignored files by path and never read them
 *
 * See also:
 * - `index-reconcile.test.ts` for staged-only intent after a checkpoint
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import type { LockingStorage } from './boundary.js';
import { type Folder, openFolder as openBrowserFolder } from './browser.js';
import {
	rawBrowserFolder,
	testBrowserStorage,
} from './browser-storage.test-support.js';
import { runHistory } from './bun.js';
import { defineFolder, defineTable, field } from './contract.js';
import { openNativeFolder } from './directory.test-support.js';
import type { GitBackend } from './git/backend.js';
import { createHistory } from './git/history.js';
import { commitTree, readTreeFiles } from './git/objects.js';
import { gitignoreMatcher } from './git/scope.js';
import {
	GIT_ENV,
	git,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';
import { overwrite, put } from './put.test-support.js';

const definition = defineFolder({
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
	'index.sqlite3': 'an intentionally saved dataset\n',
};
const SOURCE = [
	'.gitignore',
	'index.sqlite3',
	'notes/.gitignore',
	'notes/keep.log',
	'notes/plain.txt',
].sort();

async function writeLayout(folder: Folder<typeof definition>) {
	for (const [path, text] of Object.entries(LAYOUT))
		expect((await put(folder, path, text)).error).toBeNull();
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
		).toEqual(SOURCE);
	});
});

describe('browser folder scope', () => {
	test('status and commits exclude ignored files; tracked files stay tracked', async () => {
		const folder = expectOk(
			await openBrowserFolder({
				app: 'scope',
				definition,
				browser: {
					author,
					...testBrowserStorage(),
				},
			}),
		);
		// Committed before any rule matches it.
		await folder.write('tracked.log', null, 'v1\n');
		expect((await folder.git.commit()).status).toBe('committed');

		await writeLayout(folder);
		const { data: status, error: statusError } = await folder.git.status();
		expect(statusError).toBeNull();
		expect(status?.changes.map((change) => change.path)).toEqual(SOURCE);

		await put(folder, 'tracked.log', 'v2\n');
		expect(
			(await folder.git.status()).data?.changes.map((change) => change.path),
		).toEqual([...SOURCE, 'tracked.log'].sort());
		const outcome = await folder.git.commit();
		expect(outcome.status).toBe('committed');
		expect((await folder.git.status()).data?.changes).toEqual([]);
		await folder.close();
	});
});

describe('ignored files are never read', () => {
	test('status and a commit leave an ignored recording out without reading its bytes', async () => {
		const raw = await rawBrowserFolder({ id: 'scope-unread' });
		const backend = await raw.backend();
		// Any read of an ignored file fails the status or the commit that made it.
		const boundary: LockingStorage = {
			...raw.boundary,
			read(path) {
				if (path.endsWith('.wav'))
					throw new Error(`read the ignored file ${path}`);
				return raw.boundary.read(path);
			},
		};
		const history = createHistory({ backend, boundary, author });
		await overwrite(raw.boundary, '.gitignore', '*.wav\n');
		await overwrite(raw.boundary, 'notes.md', 'kept\n');
		await overwrite(raw.boundary, 'recordings/take.wav', 'audio bytes');

		const status = expectOk(await history.status());
		expect(status.changes.map((change) => change.path)).toEqual([
			'.gitignore',
			'notes.md',
		]);
		const commit = await history.commit();
		expect(commit).toMatchObject({ status: 'committed', changedPaths: 2 });
		expect(expectOk(await history.status()).changes).toEqual([]);
		await history.close();
	});
});

describe('a .gitignore read once', () => {
	test('one missing when selection reads it is not committed when it reappears', async () => {
		const raw = await rawBrowserFolder({ id: 'scope-late-gitignore' });
		const backend = await raw.backend();
		// `.gitignore` reads as missing once, as during a replace, then is back.
		let hidden = true;
		const boundary: LockingStorage = {
			...raw.boundary,
			read(path) {
				if (path === '.gitignore' && hidden) {
					hidden = false;
					return raw.boundary.read('no-such-file');
				}
				return raw.boundary.read(path);
			},
		};
		const history = createHistory({ backend, boundary, author });
		await overwrite(raw.boundary, '.gitignore', 'secret.txt\n');
		await overwrite(raw.boundary, 'notes.md', 'kept\n');
		await overwrite(raw.boundary, 'secret.txt', 'chosen without rules\n');

		const commit = await history.commit();
		expect(commit.status).toBe('committed');
		const files = await headPaths(backend);
		// Selection ran without the rules, so the commit holds no rules either:
		// the late bytes never pair with a file they would have ignored.
		expect(files).not.toContain('.gitignore');
		expect(files).toEqual(['notes.md', 'secret.txt']);
		await history.close();
	});
});

/** The paths of the branch head's tree. */
async function headPaths(backend: GitBackend) {
	const head = await backend.readBranch();
	if (head === undefined) return [];
	return backend.withObjects(async (access) =>
		[
			...(await readTreeFiles(access, await commitTree(access, head))).keys(),
		].sort(),
	);
}

describe('native folder scope', () => {
	test('agrees with git status and never commits ignored files', async () => {
		const root = await scratch('scope-native-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		await folder.write('tracked.log', null, 'v1\n');
		expect((await folder.git.commit()).status).toBe('committed');
		await writeLayout(folder);
		await put(folder, 'tracked.log', 'v2\n');

		expect(
			(await folder.git.status()).data?.changes.map((change) => change.path),
		).toEqual([...SOURCE, 'tracked.log'].sort());
		const porcelain = (
			await git(root, 'status', '--porcelain', '--untracked-files=all')
		)
			.split('\n')
			.map((line) => line.replace(/^\S+\s+/, ''))
			.sort();
		expect(porcelain).toEqual([...SOURCE, 'tracked.log'].sort());

		expect((await folder.git.commit()).status).toBe('committed');
		expect((await git(root, 'ls-files')).split('\n').sort()).toEqual(
			[...SOURCE, 'todos/.epicenter.json', 'tracked.log'].sort(),
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await folder.close();
	});

	test('a fast-forward preserves ignored files and refuses to overwrite one', async () => {
		const root = await scratch('scope-pull-');
		const bare = join(root, 'remote.git');
		await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
		const writerRoot = join(root, 'writer');
		const readerRoot = join(root, 'reader');
		for (const path of [writerRoot, readerRoot])
			await initWithOrigin(path, bare);
		const writer = await openNativeFolder({
			root: writerRoot,
			definition,
			git: { author },
		});
		const reader = await openNativeFolder({
			root: readerRoot,
			definition,
			git: { author },
		});

		await writer.write('.gitignore', null, '*.log\n');
		expect((await writer.sync.run()).data?.kind).toBe('synced');
		expect((await reader.sync.run()).data?.kind).toBe('synced');

		// Ignored local files do not make the reader dirty and survive updates.
		await writeFile(join(readerRoot, 'local.log'), 'reader only\n');
		await writeFile(join(readerRoot, 'shared.log'), 'reader copy\n');
		await writer.write('readme.md', null, 'hello\n');
		expect((await writer.sync.run()).data?.kind).toBe('synced');
		expect((await reader.sync.run()).data?.kind).toBe('synced');
		expect(await readFile(join(readerRoot, 'local.log'), 'utf8')).toBe(
			'reader only\n',
		);

		// The writer force-tracks a path the reader has as an ignored file.
		await writeFile(join(writerRoot, 'shared.log'), 'writer copy\n');
		await git(writerRoot, 'add', '--force', 'shared.log');
		await git(writerRoot, 'commit', '--quiet', '-m', 'Track shared.log');
		expect((await writer.sync.run()).data?.kind).toBe('synced');
		const { error: collision } = await reader.sync.run();
		expect(collision?.name).toBe('Blocked');
		expect(collision?.message).toContain("'shared.log'");
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

describe('an ignored file that is not tracked is never read', () => {
	test('in a browser folder, status and a commit read no ignored file', async () => {
		const raw = await rawBrowserFolder({ id: 'scope-unread' });
		await overwrite(raw.boundary, '.gitignore', 'audio/\n');
		await overwrite(raw.boundary, 'audio/take.wav', 'RIFF');
		// A rule file under an excluded directory is no rule: Git never reads it.
		await overwrite(raw.boundary, 'audio/.gitignore', '!take.wav\n');
		await overwrite(raw.boundary, 'notes.md', 'kept\n');
		const read: string[] = [];
		const boundary = {
			...raw.boundary,
			read(path: string) {
				read.push(path);
				return raw.boundary.read(path);
			},
		};
		const history = createHistory({
			backend: await raw.backend(),
			boundary,
			author,
		});
		try {
			expect(
				expectOk(await history.status()).changes.map(({ path }) => path),
			).toEqual(['.gitignore', 'notes.md']);
			expect((await history.commit()).status).toBe('committed');
			expect(read).not.toContain('audio/take.wav');
			expect(read).not.toContain('audio/.gitignore');
			expect(read).toContain('notes.md');
		} finally {
			await history.close();
		}
	});

	test('through the CLI, as the desktop runs it, an ignored file that cannot be read is never read: it stops nothing', async () => {
		const root = await scratch('scope-unread-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		await writeFile(join(root, '.gitignore'), 'audio/\n');
		await writeFile(join(root, 'notes.md'), 'kept\n');
		// A link is a file a folder never reads: reading it would refuse.
		await mkdir(join(root, 'audio'));
		await symlink(join(root, 'notes.md'), join(root, 'audio/take.wav'));
		await symlink(join(root, 'notes.md'), join(root, 'audio/.gitignore'));
		const saved = await runHistory(
			root,
			{ op: 'saveVersion', message: 'Notes' },
			{ author, application: true },
		);
		expect(saved.result).toMatchObject({ status: 'committed' });
		expect((await git(root, 'ls-files')).split('\n').sort()).toEqual([
			'.gitignore',
			'notes.md',
		]);
	});

	test('a rule file a pattern names itself still applies: what it ignores is never read nor committed', async () => {
		const files = {
			'.gitignore': '**/.gitignore\n',
			'private/.gitignore': '*.key\n',
			'private/secret.key': 'secret',
			'notes.md': 'kept\n',
		};
		// In a browser folder, by the bytes read.
		const raw = await rawBrowserFolder({ id: 'scope-self-ignored' });
		for (const [path, text] of Object.entries(files))
			await overwrite(raw.boundary, path, text);
		const read: string[] = [];
		const boundary = {
			...raw.boundary,
			read(path: string) {
				read.push(path);
				return raw.boundary.read(path);
			},
		};
		const history = createHistory({
			backend: await raw.backend(),
			boundary,
			author,
		});
		try {
			expect((await history.commit()).status).toBe('committed');
			expect(
				expectOk(await history.status()).changes.map(({ path }) => path),
			).toEqual([]);
			expect(read).not.toContain('private/secret.key');
			expect(read).toContain('private/.gitignore');
		} finally {
			await history.close();
		}
		// Through the CLI: a key it would refuse to read stops nothing.
		const root = await scratch('scope-self-ignored-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		await mkdir(join(root, 'private'));
		for (const [path, text] of Object.entries(files))
			if (path !== 'private/secret.key')
				await writeFile(join(root, path), text);
		await symlink(join(root, 'notes.md'), join(root, 'private/secret.key'));
		const saved = await runHistory(
			root,
			{ op: 'saveVersion', message: 'Notes' },
			{ author, application: true },
		);
		expect(saved.result).toMatchObject({ status: 'committed' });
		expect(await git(root, 'ls-files')).toBe('notes.md');
	});
});
