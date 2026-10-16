/**
 * Directory folders against real Git, and browser/directory exchange through
 * a real bare repository served by `git http-backend`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	configureRemote,
	createTestStorage,
	rawBrowserFolder,
} from './browser-storage.test-support.js';
import {
	type DirectoryFolderOptions,
	defineFolder,
	defineTable,
	type FolderDefinition,
	field,
	openFolder,
} from './bun.js';
import { hashBytes } from './capture.js';
import { directoryHandle } from './directory-handle.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createHistory } from './git/history.js';
import { createNativeGitBackend } from './git/native-backend.js';
import { nodeGitHost } from './git/native-host.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';
import { createOpfsFileBoundary } from './opfs-store.js';
import { parseRow } from './row-text.js';
import { useWebLocks } from './web-locks.test-support.js';

const openNativeFolder = async <const TDefinition extends FolderDefinition>(
	options: DirectoryFolderOptions<TDefinition>,
) => expectOk(await openFolder(options));

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

const author = { name: 'App', email: 'app@example.test' };
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeAll(() => {
	// Keep the developer's global Git configuration (hooks, signing) out of these runs.
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	globalThis.fetch = originalFetch;
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});

describe('native folder', () => {
	test('an existing non-main HEAD refuses history changes while file saves remain available', async () => {
		const root = await scratch('native-legacy-branch-');
		await git(root, 'init', '--quiet', '--initial-branch=backup');
		await writeFile(join(root, 'legacy.txt'), 'previous history');
		await git(root, 'add', 'legacy.txt');
		await git(root, 'commit', '--quiet', '-m', 'Previous history');
		const previous = await git(root, 'rev-parse', 'HEAD');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		try {
			expectOk(await folder.files.create('saved.txt', 'saved'));
			expect(await folder.git.commit()).toMatchObject({
				status: 'blocked',
				reason: 'HEAD is not on main',
			});
			expect(await git(root, 'rev-parse', 'HEAD')).toBe(previous);
			expect(
				await git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads'),
			).toBe('refs/heads/backup');
			expect(await readFile(join(root, 'saved.txt'), 'utf8')).toBe('saved');
		} finally {
			await folder.close();
		}
	});

	test('saves ordinary files without a commit; an explicit commit keeps the native index consistent', async () => {
		const root = await scratch('native-folder-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		expectOk(
			await folder.tables.todos.create(
				{ fields: { title: 'Walk', done: false }, body: 'Around the block.\n' },
				{ stem: 'walk' },
			),
		);

		const createdText = await readFile(join(root, 'todos/walk.md'), 'utf8');
		expect(expectOk(parseRow(definition.tables.todos, createdText))).toEqual({
			fields: { title: 'Walk', done: false },
			body: 'Around the block.\n',
		});
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		// Opening and saving create no repository; the first commit does.
		expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
		expect(await folder.git.commit()).toMatchObject({
			status: 'committed',
			message: 'Update 2 files',
		});
		expect(await git(root, 'log', '--format=%s')).toBe('Update 2 files');
		expect(await git(root, 'status', '--porcelain')).toBe('');

		// An external edit is preserved when a command updates current content.
		await writeFile(
			join(root, 'todos/walk.md'),
			createdText.replace('Walk', 'Run'),
		);
		const current = expectOk(await folder.tables.todos.get('walk'))!;
		expect(current.row.fields.title).toBe('Run');
		current.row.fields.done = true;
		const done = expectOk(
			await folder.tables.todos.save(current, current.row),
		).stored;

		expect(done.row.fields).toEqual({ title: 'Run', done: true });
		// The helper trims the leading space of the unstaged column.
		expect(await git(root, 'status', '--porcelain')).toBe('M todos/walk.md');
		expect((await folder.git.commit()).status).toBe('committed');
		expect(await git(root, 'log', '-1', '--format=%s')).toBe(
			'Update todos/walk.md',
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		// The helper trims Git's output, so only the fields are compared.
		expect(
			expectOk(
				parseRow(
					definition.tables.todos,
					await git(root, 'show', 'HEAD:todos/walk.md'),
				),
			).fields,
		).toEqual(done.row.fields);
		await folder.close();
	});

	test('a complete file save makes no commit; the next commit checkpoints external bytes with it', async () => {
		const root = await scratch('native-content-policy-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		try {
			await writeFile(join(root, 'external.md'), 'external');
			expectOk(await folder.files.create('saved.md', 'saved'));
			expect(folder.git.snapshot.lastCommit).toBeUndefined();
			expect(folder.git.snapshot.activity.commit).toEqual({ active: false });
			expect((await folder.git.commit()).status).toBe('committed');
			expect(await git(root, 'show', 'HEAD:external.md')).toBe('external');
			expect(await git(root, 'show', 'HEAD:saved.md')).toBe('saved');
			expect(await git(root, 'status', '--porcelain')).toBe('');
		} finally {
			await folder.close();
		}
	});

	test('a root that is not a directory is a returned refusal, and the handle says where it opened', async () => {
		const root = await scratch('native-root-');
		await writeFile(join(root, 'file'), 'not a directory');
		const refused = expectErr(
			await openFolder({
				root: join(root, 'file'),
				definition,
				git: { author },
			}),
		);
		expect(refused.name).toBe('InvalidRoot');
		const missing = expectErr(
			await openFolder({
				root: join(root, 'absent'),
				definition,
				git: { author },
			}),
		);
		expect(missing.name).toBe('InvalidRoot');

		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		expect(folder.location.kind).toBe('directory');
		expect(folder.location).toEqual({
			kind: 'directory',
			root: await realpath(root),
		});
		await folder.close();
	});

	test('literal lookup: a stem does not alias a differently cased file', async () => {
		const root = await scratch('native-case-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		await folder.files.create(
			'todos/Plan.md',
			'---\ntitle: P\ndone: false\n---\n',
		);
		expect((await folder.tables.todos.get('Plan')).data?.path).toBe(
			'todos/Plan.md',
		);
		expect((await folder.tables.todos.get('plan')).data).toBeUndefined();

		// Creating the other spelling is this filesystem's question, not a
		// naming rule's: it is refused exactly when both names are one file.
		const oneFile = await readFile(join(root, 'todos/plan.md')).then(
			() => true,
			() => false,
		);
		const other = await folder.tables.todos.create(
			{ fields: { title: 'Q', done: false }, body: '' },
			{ stem: 'plan' },
		);
		const plan = expectOk(await folder.tables.todos.get('Plan'))!;
		const moved = await folder.tables.todos.rename(plan, 'PLAN');
		if (oneFile) {
			expect(expectErr(other)).toMatchObject({
				name: 'Exists',
				path: 'todos/plan.md',
			});
			expect(expectErr(moved).name).toBe('Exists');
			expect(await readdir(join(root, 'todos'))).toEqual(['Plan.md']);
			expect(await readFile(join(root, 'todos/Plan.md'), 'utf8')).toBe(
				'---\ntitle: P\ndone: false\n---\n',
			);
		} else {
			expectOk(other);
			expectOk(moved);
			expect((await readdir(join(root, 'todos'))).sort()).toEqual([
				'PLAN.md',
				'plan.md',
			]);
		}
		await folder.close();
	});

	test('literal stems are rows on disk: an empty stem, a leading dot, and a trailing space; a name some disk reads as another is refused', async () => {
		const root = await scratch('native-literal-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		for (const refused of ['a: b', 'q?*', 'con'])
			expect(
				(
					await folder.tables.todos.create(
						{ fields: { title: refused, done: false }, body: '' },
						{ stem: refused },
					)
				).error,
			).not.toBeNull();
		const stems = ['', '.hidden', 'trailing ', 'naïve 日本'];
		for (const stem of stems) {
			const created = expectOk(
				await folder.tables.todos.create(
					{ fields: { title: stem, done: false }, body: '' },
					{ stem },
				),
			);
			expect(created.path).toBe(`todos/${stem}.md`);
			const bytes = await readFile(join(root, 'todos', `${stem}.md`));
			expect(await hashBytes(bytes)).toBe(created.sha256);
			expect(expectOk(await folder.tables.todos.get(stem))).toEqual(created);
			created.row.fields.done = true;
			const updated = expectOk(
				await folder.tables.todos.save(created, created.row),
			).stored;
			expect(expectOk(await folder.tables.todos.get(stem))).toEqual(updated);
		}
		// An uppercase extension is an ordinary file, not a row.
		await writeFile(join(root, 'todos/Loud.MD'), 'not a row');
		const listing = expectOk(await folder.tables.todos.list());
		expect(listing.map((item) => item.stem).sort()).toEqual([...stems].sort());
		expect(expectOk(await folder.tables.todos.get('Loud'))).toBeUndefined();

		// Bytes that are not text fail that file alone.
		await writeFile(join(root, 'todos/binary.md'), new Uint8Array([0xff, 0]));
		const withBinary = expectOk(await folder.tables.todos.list());
		expect(withBinary).toHaveLength(stems.length + 1);
		expect(
			expectErr(withBinary.find((item) => item.stem === 'binary')!.result).name,
		).toBe('InvalidUtf8');

		const empty = expectOk(await folder.tables.todos.get(''))!;
		const named = expectOk(await folder.tables.todos.rename(empty, 'named'));
		expectOk(await folder.tables.todos.delete(named));
		expect(await readdir(join(root, 'todos'))).not.toContain('.md');
		await folder.close();
	});

	test('a row is renamed and deleted alone: existing audio beside it is never moved, removed, or required', async () => {
		const root = await scratch('native-siblings-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		// Audio recorded under the old model sits beside the row it was saved with.
		const audio = new Uint8Array([1, 2, 3]);
		expectOk(await folder.files.create('todos/take.opus', audio));
		const created = expectOk(
			await folder.tables.todos.create(
				{ fields: { title: 'Take', done: false }, body: '' },
				{ stem: 'take' },
			),
		);
		const take2 = expectOk(await folder.tables.todos.rename(created, 'take2'));
		expect((await readdir(join(root, 'todos'))).sort()).toEqual([
			'take.opus',
			'take2.md',
		]);

		// The audio disappears outside the app. The row does not depend on it.
		await rm(join(root, 'todos/take.opus'));
		const take3 = expectOk(await folder.tables.todos.rename(take2, 'take3'));
		await writeFile(join(root, 'todos/take3.opus'), audio);
		await writeFile(join(root, 'todos/take3.wav'), audio);

		expectOk(await folder.tables.todos.delete(take3));
		expect((await readdir(join(root, 'todos'))).sort()).toEqual([
			'take3.opus',
			'take3.wav',
		]);
		expect(
			new Uint8Array(await readFile(join(root, 'todos/take3.opus'))),
		).toEqual(audio);
		await folder.close();
	});

	test('a branch that moves again under the retry refuses the checkpoint; the branch is never forced', async () => {
		const root = await scratch('native-cas-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		const boundary = createOpfsFileBoundary({
			root: directoryHandle(nodeDirectoryPrimitives, root),
			landed: () => {},
		});
		const backend = await createNativeGitBackend({
			root,
			branch: 'main',
			boundary,
			host: nodeGitHost(root),
		});
		const history = createHistory({
			backend: {
				...backend,
				async casBranch(expected, next) {
					await git(
						root,
						'commit',
						'--quiet',
						'--allow-empty',
						'-m',
						'Competitor',
					);
					return backend.casBranch(expected, next);
				},
			},
			boundary,
			author,
		});
		await writeFile(join(root, 'a.txt'), 'a');
		const outcome = await history.commit();
		expect(outcome.status).toBe('branchMoved');
		// The first move was retried once; the second is reported.
		expect(await git(root, 'log', '--format=%s')).toBe(
			'Competitor\nCompetitor',
		);
		if (outcome.status === 'branchMoved') {
			// The candidate exists as an unreachable object; it was not published.
			expect(await git(root, 'cat-file', '-t', outcome.candidate)).toBe(
				'commit',
			);
			expect(outcome.actual).toBe(await git(root, 'rev-parse', 'HEAD'));
		}
		await history.close();
	});

	test('saves within one process take turns: of two saves from one capture the second merges over the first, and different rows both land', async () => {
		const root = await scratch('native-turns-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		try {
			for (const stem of ['a', 'b'])
				expectOk(
					await folder.tables.todos.create(
						{ fields: { title: stem, done: false }, body: '' },
						{ stem },
					),
				);
			const a = expectOk(await folder.tables.todos.get('a'))!;
			const results = await Promise.all(
				['First', 'Second'].map((title) =>
					folder.tables.todos.save(a, {
						...a.row,
						fields: { ...a.row.fields, title },
					}),
				),
			);
			const saved = results.map((result) => expectOk(result));
			// Both changed the title: the one that merged wins.
			const merged = saved.filter((outcome) => outcome.merged);
			expect(merged).toHaveLength(1);
			const [last] = merged;
			const first = saved.find((outcome) => !outcome.merged)!;
			expect(last!.stored.row.fields.title).not.toBe(
				first.stored.row.fields.title,
			);
			const kept = expectOk(await folder.tables.todos.get('a'))!;
			expect(kept.row.fields.title).toBe(last!.stored.row.fields.title);

			const [one, two] = await Promise.all(
				(['a', 'b'] as const).map(async (stem) => {
					const current = expectOk(await folder.tables.todos.get(stem))!;
					return folder.tables.todos.save(current, {
						...current.row,
						fields: { ...current.row.fields, done: true },
					});
				}),
			);
			expectOk(one!);
			expectOk(two!);
			for (const stem of ['a', 'b'])
				expect(
					expectOk(await folder.tables.todos.get(stem))!.row.fields.done,
				).toBe(true);
		} finally {
			await folder.close();
		}
	});

	test('explicit staging uses real Git commands', async () => {
		const root = await scratch('native-stage-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		await folder.files.create('a.txt', 'a\n');
		await folder.files.create('b.txt', 'b\n');
		expectOk(await folder.git.stage(['a.txt']));
		expect((await folder.git.paths()).data).toEqual([
			{ path: 'a.txt', index: 'A', worktree: ' ' },
			{ path: 'b.txt', index: '?', worktree: '?' },
			{ path: 'epicenter.json', index: '?', worktree: '?' },
		]);
		expectOk(await folder.git.commitStaged('Stage one file'));

		expect(await git(root, 'log', '--format=%s%n%an')).toBe(
			'Stage one file\nApp',
		);
		expect(expectErr(await folder.git.commitStaged('again')).name).toBe(
			'NothingToCommit',
		);
		await folder.close();
	});
});

describe('browser and native exchange through a real bare repository', () => {
	test('browser push, native pull, native push, browser fast-forward', async () => {
		const root = await scratch('exchange-');
		const bare = await createBareRemote(root);
		globalThis.fetch = await gitHttpFetch(root);
		const environment = createTestStorage();
		await configureRemote(
			environment,
			'exchange',
			'http://git.test/remote.git',
		);
		const browser = expectOk(
			await openBrowserFolder({
				id: 'exchange',
				definition,
				browser: {
					author: { name: 'Browser', email: 'browser@example.test' },
					...browserStorage(environment),
				},
			}),
		);
		await browser.tables.todos.create(
			{ fields: { title: 'First', done: false }, body: '' },
			{ stem: 'first' },
		);
		expect((await browser.git.commit()).status).toBe('committed');
		expect(browser.git.snapshot.lastPush).toBeUndefined();
		expect((await browser.git.push()).status).toBe('pushed');
		expect(await git(bare, 'log', '--format=%s', 'main')).toBe(
			'Update 2 files',
		);

		const nativeRoot = join(root, 'native');
		await git(root, 'clone', '--quiet', bare, nativeRoot);
		const native = await openNativeFolder({
			root: nativeRoot,
			definition,
			// The clone's `origin` is the remote.
			git: { author: { name: 'Native', email: 'native@example.test' } },
		});
		expect((await native.git.fetch()).data?.oid).toBe(
			await git(bare, 'rev-parse', 'main'),
		);
		const pulled = expectOk(await native.git.pullFastForward());

		expect(pulled?.status).toBe('upToDate');
		expect(await git(nativeRoot, 'status', '--porcelain')).toBe('');
		const nativeEntry = expectOk(await native.tables.todos.get('first'))!;
		expect(nativeEntry.row.fields.title).toBe('First');

		nativeEntry.row.fields.done = true;
		const nativeDone = expectOk(
			await native.tables.todos.save(nativeEntry, nativeEntry.row),
		).stored;
		expect((await native.git.commit()).status).toBe('committed');
		expect(native.git.snapshot.lastPush).toBeUndefined();
		expect((await native.git.push()).status).toBe('pushed');
		expect(await git(bare, 'log', '-1', '--format=%s', 'main')).toBe(
			'Update todos/first.md',
		);

		expectOk(await browser.git.fetch());
		const incoming = expectOk(await browser.git.pullFastForward());

		expect(incoming?.status).toBe('fastForwarded');
		const browserEntry = expectOk(await browser.tables.todos.get('first'))!;
		expect(browserEntry.row.fields.done).toBe(true);
		expect((await browser.git.status()).data?.changes).toEqual([]);
		expect((await browser.git.paths()).data).toEqual([]);

		// A dirty folder refuses the next fast-forward before writing anything.
		nativeDone.row.fields.title = 'Native edit';
		expectOk(await native.tables.todos.save(nativeDone, nativeDone.row)).stored;
		expect((await native.git.commit()).status).toBe('committed');
		expect((await native.git.push()).status).toBe('pushed');
		// Another writer publishes without a save request on this handle.
		const external = await rawBrowserFolder({
			id: 'exchange',
			storage: environment,
		});
		const bytes = new TextEncoder().encode('local');
		expectOk(
			await external.boundary.apply([
				{
					kind: 'create',
					path: 'scratch.txt',
					bytes,
					sha256: await hashBytes(bytes),
				},
			]),
		);
		await browser.git.fetch();
		const { error: dirtyError } = await browser.git.pullFastForward();
		expect(dirtyError?.name).toBe('Dirty');
		expect(
			(await browser.tables.todos.get('first')).data!.row.fields.title,
		).toBe('First');

		// Divergence: the browser commits locally; its push is rejected and pull refuses.
		expect((await browser.git.commit()).status).toBe('committed');
		const push = await browser.git.push();
		expect(push.status).toBe('failed');
		if (push.status === 'failed')
			expect(push.error).toBe(
				"The remote branch 'main' cannot be updated by a fast-forward",
			);
		const { error: divergedError } = await browser.git.pullFastForward();
		expect(divergedError?.name).toBe('Diverged');
		expect(
			(await browser.tables.todos.get('first')).data!.row.fields.title,
		).toBe('First');

		await browser.close();
		await native.close();
		globalThis.fetch = originalFetch;
	});

	test('an unreachable remote leaves the local commit and reports the push failure', async () => {
		const environment = createTestStorage();
		await configureRemote(
			environment,
			'offline',
			'http://127.0.0.1:9/offline.git',
		);
		const browser = expectOk(
			await openBrowserFolder({
				id: 'offline',
				definition,
				browser: {
					author,
					...browserStorage(environment),
				},
			}),
		);
		expectOk(await browser.files.create('offline.txt', 'Offline'));
		expect(browser.git.snapshot.lastCommit).toBeUndefined();
		expect((await browser.git.commit()).status).toBe('committed');
		expect(browser.git.snapshot.lastPush).toBeUndefined();
		expect((await browser.git.push()).status).toBe('failed');
		expect(browser.git.snapshot.lastPush?.status).toBe('failed');
		const sync = browser.git.snapshot.sync;
		expect(sync.state === 'observed' && sync.value.ahead).toBe(1);
		expect(
			new TextDecoder().decode(
				expectOk(await browser.files.read('offline.txt')).bytes,
			),
		).toBe('Offline');
		await browser.close();
	});
});

// Commits need the shared lock; this runtime has none of its own.
useWebLocks();
