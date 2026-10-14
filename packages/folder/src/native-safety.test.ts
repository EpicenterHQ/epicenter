/**
 * Native Safety Tests
 *
 * Counterexamples against real Git and real filesystem permissions for what a
 * native folder must never claim or silently rewrite.
 *
 * Key behaviors:
 * - A raw move whose destination landed but whose source could not be
 *   retired is a `Partial` result naming both facts, merged with earlier
 *   steps; both copies stay
 * - Through the folder it is `MoveError.SourceNotRemoved` naming the guard
 *   hash at the destination; observations become stale, the move makes no
 *   commit, and the next commit records both paths
 * - A pull whose files landed while the index was locked returns
 *   `IndexFailed`, keeps HEAD, and never leaves a fresh clean observation
 * - A table lists every `.md` name it holds: a symbolic link is
 *   `InvalidPath`, a directory `NotAFile`, a pipe `InvalidPath`, and none is
 *   followed or opened
 * - A whole-folder listing names links and pipes among the files, unfollowed,
 *   and a capture leaves them out; a name that is not UTF-8 is listed by its
 *   lossy spelling, which a read refuses (on a filesystem that holds one)
 * - Whole-folder commits refuse repositories they would misrepresent
 *   (tracked or untracked symbolic links and executables, normalizing or
 *   filter attributes, `core.autocrlf`, nested Git data) before touching the
 *   branch or index; plain files keep working
 *
 * See also:
 * - `index-reconcile.test.ts` for index repair after checkpoints
 * - `source-scope.test.ts` for which files are history source
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { openNativeFolder } from './directory.test-support.js';
import {
	git,
	GIT_ENV,
	initWithOrigin,
	scratch,
} from './git-http.test-support.js';
import { createNativeFileBoundary } from './native-store.js';

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
const encoder = new TextEncoder();
/** Permission checks do not stop the root user. */
const canDenyWrites = process.getuid?.() !== 0;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});

async function writeChange(path: string, text: string) {
	const bytes = encoder.encode(text);
	return {
		kind: 'create' as const,
		path,
		bytes,
		sha256: await hashBytes(bytes),
	};
}

describe('native partial moves', () => {
	test.skipIf(!canDenyWrites)(
		'a move that cannot retire its source reports the landed destination',
		async () => {
			const root = await scratch('native-move-');
			await mkdir(join(root, 'locked'));
			await mkdir(join(root, 'open'));
			await writeFile(join(root, 'locked/a.txt'), 'A');
			await chmod(join(root, 'locked'), 0o555);
			try {
				const boundary = createNativeFileBoundary(root);
				const { error: applyError } = await boundary.apply([
					await writeChange('x.txt', 'X'),
					{ kind: 'move', from: 'locked/a.txt', to: 'open/a.txt' },
					await writeChange('y.txt', 'Y'),
				]);
				expect(applyError?.name).toBe('Partial');
				if (applyError?.name !== 'Partial') return;
				expect(applyError.applied).toEqual([
					{ kind: 'write', path: 'x.txt' },
					{ kind: 'write', path: 'open/a.txt' },
				]);
				expect(applyError.failed).toEqual({
					kind: 'remove',
					path: 'locked/a.txt',
				});
				expect(applyError.notAttempted).toEqual([
					{ kind: 'write', path: 'y.txt' },
				]);
				expect(applyError.error.name).toBe('Io');
				// Nothing is rolled back: both copies hold the bytes.
				expect(await readFile(join(root, 'locked/a.txt'), 'utf8')).toBe('A');
				expect(await readFile(join(root, 'open/a.txt'), 'utf8')).toBe('A');
				expect(await Bun.file(join(root, 'y.txt')).exists()).toBe(false);
			} finally {
				await chmod(join(root, 'locked'), 0o755);
			}
		},
	);

	test.skipIf(!canDenyWrites)(
		'a folder move that keeps its source names both paths, marks observations stale, and the next commit records what landed',
		async () => {
			const root = await scratch('native-move-folder-');
			const folder = await openNativeFolder({
				root,
				definition,
				git: { author },
			});
			const locked = expectOk(await folder.files.create('locked/a.txt', 'A'));
			await folder.files.mkdir('open');
			expect((await folder.git.commit()).status).toBe('committed');
			expect((await folder.git.status()).data?.changes).toEqual([]);
			const committed = folder.git.snapshot.lastCommit;
			await chmod(join(root, 'locked'), 0o555);
			try {
				const moved = expectErr(await folder.files.move(locked, 'open/a.txt'));
				expect(moved).toMatchObject({
					name: 'SourceNotRemoved',
					from: 'locked/a.txt',
					to: 'open/a.txt',
					moved: { path: 'open/a.txt', sha256: locked.sha256 },
					cause: { name: 'Io', path: 'locked/a.txt', operation: 'retire' },
				});
				expect(await readFile(join(root, 'locked/a.txt'), 'utf8')).toBe('A');
				expect(await readFile(join(root, 'open/a.txt'), 'utf8')).toBe('A');
				const files = folder.git.snapshot.files;
				expect(files.state === 'observed' && files.stale).toBe(true);
				// The move made no commit. The next one records both paths as they
				// are; it claims no move.
				expect(folder.git.snapshot.lastCommit).toBe(committed);
				expect(await folder.git.commit()).toMatchObject({
					status: 'committed',
					message: 'Add open/a.txt',
				});
				expect(await git(root, 'show', 'HEAD:locked/a.txt')).toBe('A');
				expect(await git(root, 'show', 'HEAD:open/a.txt')).toBe('A');
			} finally {
				await chmod(join(root, 'locked'), 0o755);
			}
			await folder.close();
		},
	);
});

describe('native listings name what reads refuse', () => {
	test('a linked, directory, or pipe row is listed with its refusal, never followed', async () => {
		const root = await scratch('native-list-');
		const outside = await scratch('native-list-outside-');
		await mkdir(join(root, 'todos'));
		await writeFile(
			join(root, 'todos', 'ok.md'),
			'---\ntitle: Ok\ndone: false\n---\n',
		);
		await writeFile(
			join(outside, 'secret.md'),
			'---\ntitle: Secret\ndone: false\n---\n',
		);
		await symlink(join(outside, 'secret.md'), join(root, 'todos', 'linked.md'));
		await mkdir(join(root, 'todos', 'dir.md'));
		const pipe =
			spawnSync('mkfifo', [join(root, 'todos', 'pipe.md')]).status === 0;

		const children = expectOk(
			await createNativeFileBoundary(root).children('todos'),
		);
		expect(children.directories).toEqual(['dir.md']);
		expect(children.files).toEqual([
			'linked.md',
			'ok.md',
			...(pipe ? ['pipe.md'] : []),
		]);

		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		const listed = expectOk(await folder.tables.todos.list());
		await folder.close();
		expect(
			listed.map(({ stem, result }) => [
				stem,
				result.error === null ? 'ok' : result.error.name,
			]),
		).toEqual([
			['dir', 'NotAFile'],
			['linked', 'InvalidPath'],
			['ok', 'ok'],
			...(pipe ? [['pipe', 'InvalidPath']] : []),
		]);
	});

	test('a name that is not UTF-8 is listed by its lossy spelling, and a read of that spelling is refused, not absent', async () => {
		const root = await scratch('native-list-bytes-');
		await mkdir(join(root, 'todos'));
		await writeFile(join(root, 'todos', 'ok.md'), 'ok');
		try {
			await writeFile(
				Buffer.from(`${join(root, 'todos')}/caf\xe9.md`, 'latin1'),
				'bytes',
			);
		} catch {
			// APFS and some other filesystems refuse such a name; Linux holds one.
			return;
		}
		const boundary = createNativeFileBoundary(root);
		expect(expectOk(await boundary.children('todos')).files).toEqual([
			'caf�.md',
			'ok.md',
		]);
		expect(
			expectOk(await boundary.list()).files.map((file) => file.path),
		).toEqual(['todos/caf�.md', 'todos/ok.md']);
		expect(expectErr(await boundary.read('todos/caf�.md'))).toMatchObject({
			name: 'InvalidPath',
			reason: 'the name on disk is not UTF-8, so no folder path names it',
		});
	});

	test('a whole-folder listing names a link and a pipe among the files without following either, and a capture leaves them out', async () => {
		const root = await scratch('native-list-all-');
		const outside = await scratch('native-list-all-outside-');
		await mkdir(join(root, 'todos'));
		await writeFile(join(root, 'todos', 'ok.md'), 'ok');
		await writeFile(join(outside, 'secret.md'), 'secret');
		await symlink(join(outside, 'secret.md'), join(root, 'todos', 'linked.md'));
		await symlink(outside, join(root, 'elsewhere'));
		const pipe =
			spawnSync('mkfifo', [join(root, 'todos', 'pipe.md')]).status === 0;
		const boundary = createNativeFileBoundary(root);

		const listing = expectOk(await boundary.list());
		expect(listing.files.map((file) => file.path)).toEqual([
			'elsewhere',
			'todos/linked.md',
			'todos/ok.md',
			...(pipe ? ['todos/pipe.md'] : []),
		]);
		// A link's size is its own, never its target's.
		expect(
			listing.files.find((file) => file.path === 'todos/linked.md')?.size,
		).toBe((await lstat(join(root, 'todos', 'linked.md'))).size);
		expect(listing.directories).toEqual(['todos']);
		expect(expectErr(await boundary.read('todos/linked.md')).name).toBe(
			'InvalidPath',
		);

		const captured = expectOk(await boundary.capture());
		expect([...captured.files.keys()]).toEqual(['todos/ok.md']);
		expect(captured.unreadable).toEqual([]);
	});
});

describe('native pull with a locked index', () => {
	test('files that landed before the index failed are never reported clean', async () => {
		const root = await scratch('native-pull-lock-');
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
		await writer.files.create('readme.md', 'A\n');
		await writer.git.commitAndPush();
		await reader.git.fetch();
		expect((await reader.git.pullFastForward()).data?.status).toBe(
			'fastForwarded',
		);
		const headA = await git(readerRoot, 'rev-parse', 'HEAD');
		expect((await reader.git.status()).data?.changes).toEqual([]);

		await writer.files.overwrite('readme.md', 'B\n');
		await writer.git.commitAndPush();
		await reader.git.fetch();
		await writeFile(join(readerRoot, '.git', 'index.lock'), '');
		const { error: pullError } = await reader.git.pullFastForward();
		expect(pullError?.name).toBe('IndexFailed');
		const files = reader.git.snapshot.files;
		expect(
			files.state === 'observed' &&
				!files.stale &&
				files.value.changes.length === 0,
		).toBe(false);
		expect(await git(readerRoot, 'rev-parse', 'HEAD')).toBe(headA);
		expect(await readFile(join(readerRoot, 'readme.md'), 'utf8')).toBe('B\n');

		await rm(join(readerRoot, '.git', 'index.lock'));
		expect((await reader.git.status()).data?.changes).toEqual([
			{ path: 'readme.md', kind: 'modify' },
		]);
		await writer.close();
		await reader.close();
	});
});

describe('native checkpoints refuse what they would misrepresent', () => {
	async function repository(prepare: (root: string) => Promise<void>) {
		const root = await scratch('native-unsupported-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		await writeFile(join(root, 'a.md'), 'A\n');
		await prepare(root);
		await git(root, 'add', '--all');
		await git(root, 'commit', '--quiet', '-m', 'Start');
		return root;
	}

	async function expectRefused(
		root: string,
		reason: string,
		after: (root: string) => Promise<void> = async () => {},
	) {
		await after(root);
		const head = await git(root, 'rev-parse', 'HEAD');
		const tree = await git(root, 'ls-tree', '-r', 'HEAD');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		// A plain edit through the folder still saves.
		expectOk(await folder.files.overwrite('a.md', 'edited\n'));
		const outcome = await folder.git.commit();
		expect(outcome.status).toBe('blocked');
		if (outcome.status === 'blocked') expect(outcome.reason).toContain(reason);
		expect(await git(root, 'rev-parse', 'HEAD')).toBe(head);
		expect(await git(root, 'ls-tree', '-r', 'HEAD')).toBe(tree);
		// The saved edit is still uncommitted (the helper trims the leading space).
		expect(await git(root, 'status', '--porcelain')).toMatch(/^ ?M a\.md$/m);
		await folder.close();
	}

	test('committing refuses a tracked symbolic link', async () => {
		const root = await repository((root) =>
			symlink('a.md', join(root, 'link.md')),
		);
		await expectRefused(root, 'link.md is tracked as a symbolic link');
		expect((await lstat(join(root, 'link.md'))).isSymbolicLink()).toBe(true);
	});

	test('committing refuses a tracked executable file', async () => {
		const root = await repository(async (root) => {
			await writeFile(join(root, 'run.sh'), 'echo hi\n');
			await chmod(join(root, 'run.sh'), 0o755);
		});
		await expectRefused(root, 'run.sh is tracked as an executable file');
	});

	test.each([
		['bad\nfile.md', 'the path contains a control character'],
		['bad\\file.md', 'the path contains a backslash'],
	])('a tracked path the folder cannot address: %j', async (path, reason) => {
		const root = await repository((root) =>
			writeFile(join(root, path), 'keep these bytes'),
		);
		await expectRefused(root, reason);
		expect(await readFile(join(root, path), 'utf8')).toBe('keep these bytes');
	});

	test('an untracked symbolic link or executable that is not ignored', async () => {
		const root = await repository(async () => {});
		await expectRefused(root, 'loose.md is a symbolic link', (root) =>
			symlink('a.md', join(root, 'loose.md')),
		);
		await rm(join(root, 'loose.md'));
		await expectRefused(root, 'tool is an executable file', async (root) => {
			await writeFile(join(root, 'tool'), 'x');
			await chmod(join(root, 'tool'), 0o755);
		});
	});

	test('committing refuses a filter attribute', async () => {
		const root = await repository(async (root) => {
			await writeFile(join(root, '.gitattributes'), '*.bin filter=lfs\n');
			await writeFile(join(root, 'data.bin'), 'bytes');
		});
		await expectRefused(root, 'data.bin has the Git attribute filter=lfs');
	});

	test('committing refuses a normalizing text attribute', async () => {
		const root = await repository((root) =>
			writeFile(join(root, '.gitattributes'), '* text=auto\n'),
		);
		await expectRefused(root, 'has the Git attribute text=auto');
	});

	test('committing refuses core.autocrlf', async () => {
		const root = await repository(async () => {});
		await expectRefused(root, 'core.autocrlf is true', (root) =>
			git(root, 'config', 'core.autocrlf', 'true').then(() => {}),
		);
	});

	test('committing refuses nested Git data', async () => {
		const root = await repository(async () => {});
		await expectRefused(root, 'sub/.git is nested Git data', async (root) => {
			await mkdir(join(root, 'sub', '.git'), { recursive: true });
			await writeFile(
				join(root, 'sub', '.git', 'HEAD'),
				'ref: refs/heads/main\n',
			);
		});
	});

	test('ignored special files and diff-only attributes do not block plain commits', async () => {
		const root = await repository(async (root) => {
			await writeFile(join(root, '.gitignore'), 'bin/\n');
			await writeFile(join(root, '.gitattributes'), '*.md diff=markdown\n');
		});
		await mkdir(join(root, 'bin'));
		await writeFile(join(root, 'bin', 'tool'), 'x');
		await chmod(join(root, 'bin', 'tool'), 0o755);
		await symlink('../a.md', join(root, 'bin', 'link'));
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		await folder.files.overwrite('a.md', 'edited\n');
		expect((await folder.git.commit()).status).toBe('committed');
		expect(await git(root, 'status', '--porcelain')).toBe('');
		await folder.close();
	});
});
