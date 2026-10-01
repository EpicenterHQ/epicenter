/**
 * Native folders against real Git, and browser/native exchange through a real
 * bare repository served by `git http-backend`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { defineStore, defineTable, field } from '../index.js';
import { createHistory } from './git/history.js';
import { createNativeGitBackend } from './git/native-backend.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';
import { type Folder, openBrowserFolder } from './index.js';
import { openNativeFolder } from './native.js';
import { createNativeFileBoundary } from './native-store.js';

const definition = defineStore({
	id: 'so.epicenter.todostest',
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
type Todos = Folder<typeof definition>;

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

async function settled(folder: Todos) {
	for (let index = 0; index < 400; index++) {
		const { activity } = folder.git.snapshot;
		if (
			!activity.commit.active &&
			!activity.commit.pending &&
			!activity.push.active &&
			!activity.push.pending
		)
			return;
		await Bun.sleep(10);
	}
	throw new Error('Git work did not settle');
}

describe('native folder', () => {
	test('saves ordinary files, commits automatically, and keeps the native index consistent', async () => {
		const root = await scratch('native-folder-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author },
		});
		const created = await folder.tables.todos.create({
			stem: 'walk',
			fields: { title: 'Walk', done: false },
			body: 'Around the block.\n',
		});
		expect(await readFile(join(root, 'todos/walk.md'), 'utf8')).toBe(
			created.data!.source,
		);
		await settled(folder);
		expect(await git(root, 'log', '--format=%s')).toBe('Add todos/walk.md');
		expect(await git(root, 'status', '--porcelain')).toBe('');

		// An external editor changes the file; the stale entry is refused.
		await writeFile(
			join(root, 'todos/walk.md'),
			created.data!.source.replace('Walk', 'Run'),
		);
		const stale = await folder.tables.todos.update(created.data!, {
			fields: { done: true },
		});
		expect(stale.error?.name).toBe('Conflict');
		const current = (await folder.tables.todos.get('walk')).data!;
		expect(current.fields.title).toBe('Run');
		const done = await folder.tables.todos.update(current, {
			fields: { done: true },
		});
		expect(done.error).toBeNull();
		await settled(folder);
		expect(await git(root, 'log', '-1', '--format=%s')).toBe(
			'Update todos/walk.md',
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		expect(await git(root, 'show', 'HEAD:todos/walk.md')).toContain(
			'done: true',
		);
		await folder.close();
	});

	test('literal lookup: a stem does not alias a differently cased file', async () => {
		const root = await scratch('native-case-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author, commitOnEdit: false },
		});
		await folder.files.write(
			'todos/Plan.md',
			'---\ntitle: P\ndone: false\n---\n',
			{ expected: 'absent' },
		);
		expect((await folder.tables.todos.get('Plan')).data?.stem).toBe('Plan');
		expect((await folder.tables.todos.get('plan')).data).toBeUndefined();
		await folder.close();
	});

	test('a rename whose captured attachment vanished is refused before anything moves', async () => {
		const root = await scratch('native-vanished-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author, commitOnEdit: false },
		});
		const created = (
			await folder.tables.todos.create({
				stem: 'take',
				fields: { title: 'Take', done: false },
				attachment: { extension: 'opus', bytes: new Uint8Array([1, 2, 3]) },
			})
		).data!;
		// The attachment disappears after the entry was captured.
		await rm(join(root, 'todos/take.opus'));
		const renamed = await folder.tables.todos.rename(created, 'take2');
		expect(renamed.error?.name).toBe('AmbiguousAttachment');
		expect(await readFile(join(root, 'todos/take.md'), 'utf8')).toBe(
			created.source,
		);
		expect((await folder.files.read('todos/take2.md')).error?.name).toBe(
			'NotFound',
		);
		await folder.close();
	});

	test('a competing native commit refuses the checkpoint; the branch is never forced', async () => {
		const root = await scratch('native-cas-');
		await git(root, 'init', '--quiet', '--initial-branch=main');
		const boundary = createNativeFileBoundary(root);
		const backend = await createNativeGitBackend({
			root,
			branch: 'main',
			remote: undefined,
			boundary,
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
			commitOnEdit: false,
		});
		await writeFile(join(root, 'a.txt'), 'a');
		const outcome = await history.commit();
		expect(outcome.status).toBe('branchMoved');
		expect(await git(root, 'log', '--format=%s')).toBe('Competitor');
		if (outcome.status === 'branchMoved') {
			// The candidate exists as an unreachable object; it was not published.
			expect(await git(root, 'cat-file', '-t', outcome.candidate)).toBe(
				'commit',
			);
			expect(outcome.actual).toBe(await git(root, 'rev-parse', 'HEAD'));
		}
		await history.close();
	});

	test('explicit staging uses real Git commands', async () => {
		const root = await scratch('native-stage-');
		const folder = await openNativeFolder({
			root,
			definition,
			git: { author, commitOnEdit: false },
		});
		await folder.files.write('a.txt', 'a\n', { expected: 'absent' });
		await folder.files.write('b.txt', 'b\n', { expected: 'absent' });
		expect((await folder.git.stage(['a.txt'])).error).toBeNull();
		expect((await folder.git.paths()).data).toEqual([
			{ path: 'a.txt', index: 'A', worktree: ' ' },
			{ path: 'b.txt', index: '?', worktree: '?' },
		]);
		const committed = await folder.git.commitStaged('Stage one file');
		expect(committed.error).toBeNull();
		expect(await git(root, 'log', '--format=%s%n%an')).toBe(
			'Stage one file\nApp',
		);
		expect((await folder.git.commitStaged('again')).error?.name).toBe(
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
		const browserRemote = { url: 'http://git.test/remote.git', branch: 'main' };

		const browser = await openBrowserFolder({
			id: 'exchange',
			definition,
			git: {
				author: { name: 'Browser', email: 'browser@example.test' },
				remote: browserRemote,
			},
			indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
		});
		await browser.tables.todos.create({
			stem: 'first',
			fields: { title: 'First', done: false },
		});
		await settled(browser);
		expect(browser.git.snapshot.lastPush?.status).toBe('pushed');
		expect(await git(bare, 'log', '--format=%s', 'main')).toBe(
			'Add todos/first.md',
		);

		const nativeRoot = join(root, 'native');
		await git(root, 'init', '--quiet', '--initial-branch=main', nativeRoot);
		const native = await openNativeFolder({
			root: nativeRoot,
			definition,
			git: {
				author: { name: 'Native', email: 'native@example.test' },
				remote: { url: bare, branch: 'main' },
			},
		});
		expect((await native.git.fetch()).data?.oid).toBe(
			await git(bare, 'rev-parse', 'main'),
		);
		const pulled = await native.git.pullFastForward();
		expect(pulled.data?.status).toBe('fastForwarded');
		expect(await git(nativeRoot, 'status', '--porcelain')).toBe('');
		const nativeEntry = (await native.tables.todos.get('first')).data!;
		expect(nativeEntry.fields.title).toBe('First');

		await native.tables.todos.update(nativeEntry, { fields: { done: true } });
		await settled(native);
		expect(native.git.snapshot.lastPush?.status).toBe('pushed');
		expect(await git(bare, 'log', '-1', '--format=%s', 'main')).toBe(
			'Update todos/first.md',
		);

		expect((await browser.git.fetch()).error).toBeNull();
		const incoming = await browser.git.pullFastForward();
		expect(incoming.data?.status).toBe('fastForwarded');
		const browserEntry = (await browser.tables.todos.get('first')).data!;
		expect(browserEntry.fields.done).toBe(true);
		expect((await browser.git.status()).data?.changes).toEqual([]);
		expect((await browser.git.paths()).data).toEqual([]);

		// A dirty folder refuses the next fast-forward before writing anything.
		await native.tables.todos.update(
			(await native.tables.todos.get('first')).data!,
			{ fields: { title: 'Native edit' } },
		);
		await settled(native);
		await browser.files.write('scratch.txt', 'local', { expected: 'absent' });
		await browser.git.fetch();
		const dirty = await browser.git.pullFastForward();
		expect(dirty.error?.name).toBe('Dirty');
		expect((await browser.tables.todos.get('first')).data!.fields.title).toBe(
			'First',
		);

		// Divergence: the browser commits locally; its push is rejected and pull refuses.
		expect((await browser.git.commit()).status).toBe('committed');
		const push = await browser.git.push();
		expect(push.status).toBe('failed');
		const diverged = await browser.git.pullFastForward();
		expect(diverged.error?.name).toBe('Diverged');
		expect((await browser.tables.todos.get('first')).data!.fields.title).toBe(
			'First',
		);

		await browser.close();
		await native.close();
		globalThis.fetch = originalFetch;
	});

	test('an unreachable remote leaves the local commit and reports the push failure', async () => {
		const browser = await openBrowserFolder({
			id: 'offline',
			definition,
			git: {
				author,
				remote: { url: 'http://127.0.0.1:9/offline.git', branch: 'main' },
			},
			indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
		});
		await browser.tables.todos.create({
			stem: 'offline',
			fields: { title: 'Offline', done: false },
		});
		await settled(browser);
		expect(browser.git.snapshot.lastCommit?.status).toBe('committed');
		expect(browser.git.snapshot.lastPush?.status).toBe('failed');
		const sync = browser.git.snapshot.sync;
		expect(sync.state === 'observed' && sync.value.ahead).toBe(1);
		expect((await browser.tables.todos.get('offline')).data!.fields.title).toBe(
			'Offline',
		);
		await browser.close();
	});
});
