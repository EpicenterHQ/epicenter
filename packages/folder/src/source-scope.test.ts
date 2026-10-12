/**
 * History Source Scope Tests
 *
 * Status, automatic commits, and incoming fast-forwards share one inclusion
 * rule: tracked files stay source, untracked files are source unless
 * `.gitignore` excludes them. SQLite filenames have no special source policy.
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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	rawBrowserFolder,
} from './browser-storage.test-support.js';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { openNativeFolder } from './directory.test-support.js';
import { gitignoreMatcher } from './git/scope.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';

const definition = defineFolder({
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
	'index.sqlite3': 'an intentionally saved dataset\n',
};
const SOURCE = [
	'.gitignore',
	'index.sqlite3',
	'notes/.gitignore',
	'notes/keep.log',
	'notes/plain.txt',
].sort();

/**
 * Write `files` as another program or tab would: saved, and not committed
 * until a commit is asked for, so status sees them.
 */
async function writeOutside(
	write: (path: string, text: string) => Promise<void>,
	files: Record<string, string>,
) {
	for (const [path, text] of Object.entries(files)) await write(path, text);
}

function inBrowser(id: string, storage: ReturnType<typeof createTestStorage>) {
	return async (path: string, text: string) => {
		const { boundary } = await rawBrowserFolder({ id, storage });
		const bytes = encode(text);
		expectOk(
			await boundary.apply([
				{ kind: 'overwrite', path, bytes, sha256: await hashBytes(bytes) },
			]),
		);
	};
}

function onDisk(root: string) {
	return async (path: string, text: string) => {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	};
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
		const storage = createTestStorage();
		const folder = expectOk(
			await openBrowserFolder({
				id: 'scope',
				definition,
				browser: {
					author,
					...browserStorage(storage),
				},
			}),
		);
		const outside = inBrowser('scope', storage);
		// Committed before any rule matches it.
		await folder.files.create('tracked.log', 'v1\n');
		await folder.git.commit();

		await writeOutside(outside, LAYOUT);
		const { data: status, error: statusError } = await folder.git.status();
		expect(statusError).toBeNull();
		expect(status?.changes.map((change) => change.path)).toEqual(SOURCE);

		await outside('tracked.log', 'v2\n');
		expect(
			(await folder.git.status()).data?.changes.map((change) => change.path),
		).toEqual([...SOURCE, 'tracked.log'].sort());
		const outcome = await folder.git.commit();
		expect(outcome.status).toBe('committed');
		expect((await folder.git.status()).data?.changes).toEqual([]);
		// Folder commits include the same authored SQLite path as ordinary Git.
		expect((await folder.git.paths()).data).toEqual([]);
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
			git: { author },
		});
		await folder.files.create('tracked.log', 'v1\n');
		await folder.git.commit();
		await writeOutside(onDisk(root), { ...LAYOUT, 'tracked.log': 'v2\n' });

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
			[...SOURCE, 'epicenter.json', 'tracked.log'].sort(),
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
		await git(root, 'init', '--quiet', '--initial-branch=main', writerRoot);
		const remote = { url: bare, branch: 'main' };
		const writer = await openNativeFolder({
			root: writerRoot,
			definition,
			git: { author, remote },
		});

		await writer.files.create('.gitignore', '*.log\n');
		expect((await writer.git.commitAndPush()).push.status).toBe('pushed');
		// The reader starts from the writer's history.
		await git(root, 'clone', '--quiet', bare, readerRoot);
		const reader = await openNativeFolder({
			root: readerRoot,
			definition,
			git: { author, remote },
		});
		await reader.git.commit();
		expect(await git(readerRoot, 'rev-parse', 'HEAD')).toBe(
			await git(writerRoot, 'rev-parse', 'HEAD'),
		);

		// Ignored local files do not make the reader dirty and survive updates.
		await writeFile(join(readerRoot, 'local.log'), 'reader only\n');
		await writeFile(join(readerRoot, 'shared.log'), 'reader copy\n');
		await writer.files.create('readme.md', 'hello\n');
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
		const { error: collision } = await reader.git.pullFastForward();
		expect(collision?.name).toBe('Collision');
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
