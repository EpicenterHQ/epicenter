/**
 * Staged Commits on Disk
 *
 * A Bun directory folder commits the index without `git commit`: it pins the
 * branch head, writes the index's tree from a private copy of the index and
 * a commit naming that head, and moves the branch by compare-and-swap. Each
 * test stages with real Git and checks the result with real Git.
 *
 * Key behaviors:
 * - A branch another program moves after the parent is pinned is refused as
 *   `BranchMoved` naming both commits; the index keeps its exact bytes
 * - A commit reports the parent it was written on
 * - The commit's tree is the tree Git writes from the same index: modes,
 *   deletions, and staged empty files kept, intent-to-add entries left out
 *
 * See also:
 * - `merge.test.ts` for a staged commit refused while another program's merge is in progress
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import * as real from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createHistory } from './git/history.js';
import { createNativeGitBackend } from './git/native-backend.js';
import { nodeGitHost } from './git/native-host.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';
import { createNativeFileBoundary } from './native-store.js';

/** Runs when the backend copies the index, after the parent is pinned. */
let copying: (() => Promise<void>) | undefined;

const roots: string[] = [];
const opened: { close(): Promise<void> }[] = [];
const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});
afterEach(async () => {
	copying = undefined;
	for (const made of opened.splice(0)) await made.close();
	for (const root of roots.splice(0))
		await real.rm(root, { recursive: true, force: true });
});

/** A manual-history folder whose `base.md` and `gone.md` are committed by Git. */
async function folder() {
	const root = await scratch('staged-native-');
	roots.push(root);
	await git(root, 'init', '--quiet', '--initial-branch=main');
	await real.writeFile(join(root, 'base.md'), 'base\n');
	await real.writeFile(join(root, 'gone.md'), 'gone\n');
	await git(root, 'add', '--all');
	await git(root, 'commit', '--quiet', '-m', 'Base');
	const boundary = createNativeFileBoundary(root);
	const backend = await createNativeGitBackend({
		root,
		branch: 'main',
		remote: undefined,
		boundary,
		// Another program acts between the pinned parent and the
		// compare-and-swap: when the backend writes its private index copy.
		host: (() => {
			const host = nodeGitHost(root);
			return {
				...host,
				files: {
					...host.files,
					async writeFile(path, bytes, options) {
						if (path.includes('/.git/index.tmp-')) {
							const acting = copying;
							copying = undefined;
							await acting?.();
						}
						return host.files.writeFile(path, bytes, options);
					},
				},
			};
		})(),
	});
	const history = createHistory({
		backend,
		boundary,
		author: { name: 'Stager', email: 'stager@example.test' },
	});
	opened.push(history);
	return { root, history, base: await git(root, 'rev-parse', 'HEAD') };
}

const indexBytes = (root: string) => real.readFile(join(root, '.git/index'));

test('a branch moved after the parent is pinned refuses the commit and keeps the index', async () => {
	const { root, history, base } = await folder();
	await real.writeFile(join(root, 'note.md'), 'note\n');
	await git(root, 'add', 'note.md');
	// Enable split indexes after staging: the private write must not leave
	// a shared index that no live index references.
	await git(root, 'config', 'core.splitIndex', 'true');
	const sibling = await git(
		root,
		'commit-tree',
		`${base}^{tree}`,
		'-p',
		base,
		'-m',
		'Another owner',
	);
	const before = {
		bytes: await indexBytes(root),
		listed: await git(root, 'ls-files', '--stage'),
	};
	copying = () =>
		git(root, 'update-ref', 'refs/heads/main', sibling, base).then(() => {});

	expect(expectErr(await history.commitStaged('Add note'))).toMatchObject({
		name: 'BranchMoved',
		expected: base,
		actual: sibling,
	});

	expect(await git(root, 'rev-parse', 'refs/heads/main')).toBe(sibling);
	expect(await indexBytes(root)).toEqual(before.bytes);
	expect(await git(root, 'ls-files', '--stage')).toBe(before.listed);
	expect(
		(await real.readdir(join(root, '.git'))).filter(
			(entry) =>
				entry.includes('.tmp-') ||
				entry.startsWith('sharedindex.') ||
				entry === 'index.lock',
		),
	).toEqual([]);

	// The next commit is written on the branch as it is, and says so.
	const committed = expectOk(await history.commitStaged('Add note'));
	expect(committed.parent).toBe(sibling);
	expect(await git(root, 'log', '-1', '--format=%P', committed.oid)).toBe(
		sibling,
	);
	expect(await git(root, 'rev-parse', 'refs/heads/main')).toBe(committed.oid);
});

test('an intent-to-add entry alone is nothing to commit', async () => {
	const { root, history, base } = await folder();
	await real.writeFile(join(root, 'planned.txt'), 'later\n');
	await git(root, 'add', '--intent-to-add', 'planned.txt');

	expect(expectErr(await history.commitStaged('Plan')).name).toBe(
		'NothingToCommit',
	);
	expect(await git(root, 'rev-parse', 'HEAD')).toBe(base);
});

test('built-in staged commits run no commit hooks and ignore configured signing', async () => {
	const { root, history } = await folder();
	await real.writeFile(join(root, 'note.md'), 'note\n');
	await git(root, 'add', 'note.md');
	await real.writeFile(
		join(root, '.git/hooks/pre-commit'),
		'#!/bin/sh\nprintf ran > hook-ran\nexit 1\n',
		{ mode: 0o755 },
	);
	await git(root, 'config', 'commit.gpgSign', 'true');
	await git(root, 'config', 'gpg.program', '/nonexistent-folder-test-signer');

	const committed = expectOk(await history.commitStaged('Add note'));

	expect(await Bun.file(join(root, 'hook-ran')).exists()).toBe(false);
	expect(await git(root, 'cat-file', 'commit', committed.oid)).not.toContain(
		'\ngpgsig ',
	);
});

test('the commit records the tree Git writes from the index, with modes, deletions, and empty files', async () => {
	const { root, history, base } = await folder();
	await real.writeFile(join(root, 'tool.sh'), '#!/bin/sh\n');
	await real.chmod(join(root, 'tool.sh'), 0o755);
	await real.symlink('base.md', join(root, 'link'));
	await real.writeFile(join(root, 'empty.txt'), '');
	await real.rm(join(root, 'gone.md'));
	await git(root, 'add', '--', 'tool.sh', 'link', 'empty.txt', 'gone.md');
	await git(
		root,
		'update-index',
		'--add',
		'--cacheinfo',
		`160000,${base},vendor/sub`,
	);
	await real.writeFile(join(root, 'planned.txt'), 'later\n');
	await git(root, 'add', '--intent-to-add', 'planned.txt');
	const before = await indexBytes(root);

	const committed = expectOk(await history.commitStaged('Tools'));

	expect(committed.parent).toBe(base);
	expect(await indexBytes(root)).toEqual(before);
	const listed = await git(root, 'ls-tree', '-r', committed.oid);
	expect(
		listed.split('\n').map((line) => line.replace(/ [0-9a-f]{40}\t/, ' ')),
	).toEqual([
		'100644 blob base.md',
		'100644 blob empty.txt',
		'120000 blob link',
		'100755 blob tool.sh',
		'160000 commit vendor/sub',
	]);
	expect(await git(root, 'rev-parse', `${committed.oid}:empty.txt`)).toBe(
		await git(root, 'hash-object', '-t', 'blob', '/dev/null'),
	);
	expect(await git(root, 'rev-parse', `${committed.oid}^{tree}`)).toBe(
		await git(root, 'write-tree'),
	);
	// The intended file stays in the index, outside the commit.
	expect(await git(root, 'ls-files', '--', 'planned.txt')).toBe('planned.txt');
});
