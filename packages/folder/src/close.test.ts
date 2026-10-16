/**
 * Folder close fences the next storage call, without waiting for file helpers.
 * An already-started application returns its actual outcome. Git work still
 * drains before release, and closing makes no last commit.
 *
 * Key behaviors:
 * - Preparation before publication can be refused by close without writing
 * - Close resolves while a begun file application's reply remains pending
 * - Started browser applications finish after storage is released
 * - Git work and reentrant close retain their resource lifetime guarantees
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FolderStorage } from './boundary.js';
import { openFolder as openBrowserFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	locationOf,
	rawBrowserFolder,
} from './browser-storage.test-support.js';
import {
	DECLARATION_PATH,
	defineFolder,
	defineTable,
	field,
} from './contract.js';
import { openNativeFolder } from './directory.test-support.js';
import { assembleFolder, createFileHints } from './folder.js';
import type { GitBackend } from './git/backend.js';
import { createHistory } from './git/history.js';
import { GIT_ENV, scratch } from './git-http.test-support.js';
import { withPublication } from './storage.js';
import { useWebLocks } from './web-locks.test-support.js';

const definition = defineFolder({
	tables: { todos: defineTable({ fields: { title: field.string() } }) },
});
const author = { name: 'Close', email: 'close@example.test' };

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

test('browser helpers still preparing when close starts are refused without writing', async () => {
	const environment = createTestStorage();
	const open = async () =>
		expectOk(
			await openBrowserFolder({
				id: 'so.epicenter.closetest',
				definition,
				browser: { author, ...browserStorage(environment) },
			}),
		);
	const folder = await open();
	const saving = folder.write('note.md', null, 'preparing');
	const row = folder.tables.todos.create(
		{ fields: { title: 'Last' }, body: '' },
		{ stem: 'last' },
	);
	await folder.close();
	expect(expectErr(await saving).name).toBe('Closed');
	expect(expectErr(await row).name).toBe('Closed');
	expect(expectErr(await folder.write('late.md', null, 'late')).name).toBe(
		'Closed',
	);
	expect(folder.git.snapshot.closed).toBe(true);
	expect(folder.git.snapshot.lastCommit).toBeUndefined();
	// Nothing landed, so nothing was written: not even the declaration.
	const reopened = await open();
	expect(
		expectOk(await reopened.files.list()).files.map((file) => file.path),
	).toEqual([]);
	await reopened.close();
});

test('a directory helper still hashing at close is refused; the caller must await its save', async () => {
	const root = await scratch('close-preparing-');
	const folder = await openNativeFolder({ root, definition, git: { author } });
	const preparing = folder.write('refused.md', null, 'not yet published');
	await folder.close();
	expect(expectErr(await preparing).name).toBe('Closed');
	// Opening wrote nothing, and the refused save wrote nothing either.
	expect(await readdir(root)).toEqual([]);
	const reopened = await openNativeFolder({
		root,
		definition,
		git: { author },
	});
	expectOk(await reopened.write('saved.md', null, 'awaited by caller'));
	await reopened.close();
	// Saves stage their bytes inside `.git`; no repository is made there.
	expect((await readdir(root)).sort()).toEqual([
		'.git',
		'epicenter.json',
		'saved.md',
	]);
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
});

/** A real browser history over a boundary whose next publication the test holds. */
async function held() {
	const raw = await rawBrowserFolder({ id: 'close' });
	const base = raw.boundary;
	const order: string[] = [];
	const { promise: released, resolve: release } = Promise.withResolvers<void>();
	const { promise: reached, resolve: reach } = Promise.withResolvers<void>();
	const boundary: FolderStorage = {
		...base,
		async put(path, bytes, ifMatch) {
			if (path === DECLARATION_PATH) return base.put(path, bytes, ifMatch);
			const putting = base.put(path, bytes, ifMatch);
			reach();
			await released;
			const result = await putting;
			order.push('saved');
			return result;
		},
	};
	const real = await raw.backend({
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
	});
	let pushes = 0;
	const commits = {
		/** Set to hold the next commit just before it moves the branch. */
		hold: undefined as Promise<void> | undefined,
		/** Called when a commit reaches the branch move, before any hold. */
		reached: undefined as (() => void) | undefined,
	};
	const backend: GitBackend = {
		...real,
		async push() {
			pushes++;
			return 'pushed' as const;
		},
		async casBranch(expected, next) {
			commits.reached?.();
			await commits.hold;
			const moved = await real.casBranch(expected, next);
			order.push('committed');
			return moved;
		},
	};
	const history = createHistory({ backend, boundary, author });
	const hints = createFileHints();
	const folder = assembleFolder<typeof definition, typeof definition>({
		prepared: definition,
		publishes: true,
		storage: withPublication({ storage: boundary, history }),
		history,
		location: locationOf('close'),
		hints,
		release: async () => {
			order.push('released');
		},
	});
	return {
		folder,
		order,
		reached,
		release,
		real,
		commits,
		base,
		pushes: () => pushes,
	};
}

test('closing releases storage before a begun save replies; its actual result stays successful', async () => {
	const { folder, order, reached, release, pushes } = await held();
	const snapshots: boolean[] = [];
	folder.git.subscribe((snapshot) => snapshots.push(snapshot.closed));

	const saving = folder.tables.todos.create(
		{ fields: { title: 'Dark' }, body: '' },
		{ stem: 'one' },
	);
	await reached;
	let closed = false;
	const closing = folder.close().then(() => {
		closed = true;
	});

	// The save is still held. Closing has already fenced everything else.
	expect(folder.signal.aborted).toBe(true);
	expect(folder.git.snapshot.closed).toBe(true);
	expect(expectErr(await folder.files.list()).name).toBe('Closed');
	expect(expectErr(await folder.write('late.md', null, 'x')).name).toBe(
		'Closed',
	);
	expect(await folder.git.commit()).toEqual({ status: 'closed' });
	expect(expectErr(await folder.git.status()).name).toBe('Closed');
	expect(expectErr(await folder.sync.run()).name).toBe('Closed');
	await Bun.sleep(20);
	// File replies are owned by their callers, not close.
	expect(closed).toBe(true);
	expect(order).toEqual(['released']);

	release();
	const saved = expectOk(await saving);
	await closing;

	expect(saved).toMatchObject({ row: { fields: { title: 'Dark' } } });
	// The save landed after closing began, and closing made no commit.
	expect(order).toEqual(['released', 'saved']);
	expect(folder.git.snapshot.lastCommit).toBeUndefined();
	expect(pushes()).toBe(0);
	expect(snapshots.at(-1)).toBe(true);
});

test('a commit running when the folder closes finishes and stays local before storage is released', async () => {
	const { folder, order, reached, release, commits, pushes } = await held();
	const { promise: holding, resolve: letGo } = Promise.withResolvers<void>();
	commits.hold = holding;
	const saving = folder.tables.todos.create(
		{ fields: { title: 'Dark' }, body: '' },
		{ stem: 'one' },
	);
	await reached;
	release();
	expectOk(await saving);
	// The save made no commit; this one is asked for, and held.
	expect(folder.git.snapshot.activity.commit).toEqual({ active: false });
	const { promise: inside, resolve: enter } = Promise.withResolvers<void>();
	commits.reached = enter;
	const committing = folder.git.commit();
	expect(folder.git.snapshot.activity.commit).toEqual({ active: true });
	// Inside the protection: close waits for it instead of refusing it.
	await inside;

	let closed = false;
	const closing = folder.close().then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	expect(closed).toBe(false);
	expect(order).toEqual(['saved']);

	letGo();
	await closing;
	expect(order).toEqual(['saved', 'committed', 'released']);
	// The first commit holds the declaration published before the first
	// save, and the row.
	expect(await committing).toMatchObject({
		status: 'committed',
		message: 'Update 2 files',
		changedPaths: 2,
	});
	expect(folder.git.snapshot.lastCommit).toMatchObject({
		status: 'committed',
		message: 'Update 2 files',
	});
	// The commit finished during close, so it stayed local.
	expect(pushes()).toBe(0);
});

test('close reentered by abort and history observers shares one completion and releases once', async () => {
	const { folder, order } = await held();
	let fromAbort: Promise<void> | undefined;
	let fromHistory: Promise<void> | undefined;
	folder.signal.addEventListener('abort', () => {
		fromAbort = folder.close();
	});
	const unsubscribe = folder.git.subscribe((snapshot) => {
		if (snapshot.closed) fromHistory = folder.close();
	});

	const closing = folder.close();
	expect(fromAbort).toBe(closing);
	expect(fromHistory).toBe(closing);
	await closing;
	unsubscribe();
	expect(order).toEqual(['released']);
	expect(folder.close()).toBe(closing);
});

// Commits need the shared lock; this runtime has none of its own.
useWebLocks();
