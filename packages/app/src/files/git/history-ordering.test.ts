/**
 * History Ordering and Ownership Tests
 *
 * Counterexamples for how the history coordinator orders captures, owns
 * explicit Git work until close, reacts to incoming changes that landed only
 * partly, and decides which commits push.
 *
 * Key behaviors:
 * - A pending checkpoint pins its parent and captures files inside the Git
 *   lock, so it cannot commit an older capture over a newer incoming head
 * - An external branch move between that pin and publication is refused
 * - `close()` waits for held `stage` and `commitStaged` work, including the
 *   staged commit's refresh, and starts no network work
 * - A pull whose files landed but whose index or branch did not never leaves
 *   a fresh clean observation behind
 * - Explicit `commit()` never pushes; only managed-save requests and
 *   `commitAndPush()` do, once per pass
 *
 * See also:
 * - `history.test.ts` for cancellation of outgoing work on close
 */
import { expect, test } from 'bun:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { FileBoundary } from '../boundary.js';
import {
	createBrowserFileBoundary,
	openFolderDatabase,
} from '../browser-store.js';
import { FileError } from '../errors.js';
import { captureVersion } from '../version.js';
import type { GitBackend, PublishResult } from './backend.js';
import { createBrowserGitBackend } from './browser-backend.js';
import { createHistory } from './history.js';
import { writeCommitObject, writeFilesTree } from './objects.js';

const author = { name: 'History', email: 'history@example.test' };
const encoder = new TextEncoder();

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

async function until(condition: () => boolean) {
	for (let index = 0; index < 200 && !condition(); index++) await Bun.sleep(2);
	expect(condition()).toBe(true);
}

async function setup(
	overrides: (real: GitBackend) => Partial<GitBackend> = () => ({}),
	options: {
		commitOnEdit?: boolean;
		boundary?: (base: FileBoundary) => FileBoundary;
	} = {},
) {
	const environment = { indexedDB: new IDBFactory(), IDBKeyRange };
	const db = await openFolderDatabase('epicenter-folder:ordering', environment);
	const base = createBrowserFileBoundary(db, environment);
	const real = await createBrowserGitBackend({
		db,
		environment,
		lockName: 'ordering',
		branch: 'main',
		remote: undefined,
	});
	let pushStarts = 0;
	const backend: GitBackend = {
		...real,
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
		async push() {
			pushStarts++;
		},
		...overrides(real),
	};
	const boundary = options.boundary?.(base) ?? base;
	const history = createHistory({
		backend,
		boundary,
		author,
		commitOnEdit: options.commitOnEdit ?? true,
	});
	async function write(path: string, text: string) {
		const bytes = encoder.encode(text);
		const applied = await base.apply([
			{
				kind: 'write',
				path,
				bytes,
				version: await captureVersion(bytes),
				expected: 'any',
			},
		]);
		expect(applied.error).toBeNull();
	}
	/** A commit another owner writes: `files` on top of `parent`. */
	function commitOf(parent: string | undefined, files: Record<string, string>) {
		return real.withObjects(async (access) =>
			writeCommitObject(access, {
				tree: await writeFilesTree(
					access,
					new Map(
						Object.entries(files).map(([path, text]) => [
							path,
							encoder.encode(text),
						]),
					),
				),
				parents: parent === undefined ? [] : [parent],
				message: 'Another owner',
				author,
			}),
		);
	}
	return {
		db,
		real,
		base,
		history,
		write,
		commitOf,
		pushes: () => pushStarts,
	};
}

test('a checkpoint waiting for the Git lock cannot revert files and a head that landed meanwhile', async () => {
	const { db, real, history, write, commitOf } = await setup();
	await write('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');

	const held = gate();
	// Another owner holds the lock and publishes files and branch together, as a pull does.
	const owner = real.exclusive(async () => {
		await held.opened;
		await write('a.txt', 'two');
		const parent = await real.readBranch();
		const incoming = await commitOf(parent, { 'a.txt': 'two' });
		expect((await real.casBranch(parent, incoming)).ok).toBe(true);
		return incoming;
	});
	const pending = history.commit();
	// Before the fix, the pass captured `one` here, outside the lock.
	await Bun.sleep(20);
	held.open();
	const incoming = await owner;
	const outcome = await pending;
	expect(outcome.status).toBe('unchanged');
	expect(await real.readBranch()).toBe(incoming);
	await history.close();
	db.close();
});

test('an external branch move after the parent is pinned is refused, not overwritten', async () => {
	let arm = false;
	let competitor: string | undefined;
	const { db, real, history, write, commitOf } = await setup(() => ({}), {
		boundary: (base) => ({
			...base,
			async capture() {
				const captured = await base.capture();
				if (arm) {
					arm = false;
					const parent = await real.readBranch();
					competitor = await commitOf(parent, { 'elsewhere.txt': 'x' });
					expect((await real.casBranch(parent, competitor)).ok).toBe(true);
				}
				return captured;
			},
		}),
	});
	await write('a.txt', 'one');
	await history.commit();
	await write('b.txt', 'local');
	arm = true;
	const outcome = await history.commit();
	expect(outcome.status).toBe('branchMoved');
	expect(await real.readBranch()).toBe(competitor);
	await history.close();
	db.close();
});

test('close waits for a held stage and a held staged commit, including its refresh', async () => {
	const stageGate = gate();
	const commitGate = gate();
	const { db, history, write, pushes } = await setup((real) => ({
		async stage(paths) {
			await stageGate.opened;
			return real.stage(paths);
		},
		async commitIndex(message, commitAuthor) {
			await commitGate.opened;
			return real.commitIndex(message, commitAuthor);
		},
	}));
	await write('a.txt', 'one');
	const staging = history.stage(['a.txt']);
	let closed = false;
	let closing = history.close().then(() => {
		closed = true;
	});
	await Bun.sleep(10);
	expect(closed).toBe(false);
	expect((await history.stage(['a.txt'])).error?.name).toBe('Closed');
	stageGate.open();
	expect((await staging).error).toBeNull();
	await closing;
	expect(closed).toBe(true);
	db.close();

	// A fresh history: a held staged commit keeps close open through its refresh.
	const second = await setup((real) => ({
		async commitIndex(message, commitAuthor) {
			await commitGate.opened;
			return real.commitIndex(message, commitAuthor);
		},
	}));
	await second.write('a.txt', 'one');
	expect((await second.history.stage(['a.txt'])).error).toBeNull();
	const committing = second.history.commitStaged('Stage one file');
	let lastCommitAtClose: unknown;
	closing = second.history.close().then(() => {
		lastCommitAtClose = second.history.snapshot.lastCommit;
	});
	await Bun.sleep(10);
	expect(lastCommitAtClose).toBeUndefined();
	commitGate.open();
	expect((await committing).error).toBeNull();
	await closing;
	expect(lastCommitAtClose).toMatchObject({
		status: 'committed',
		message: 'Stage one file',
	});
	expect(pushes() + second.pushes()).toBe(0);
	second.db.close();
});

for (const status of ['partial', 'indexFailed', 'branchMoved'] as const) {
	test(`a pull that returns ${status} after files landed invalidates the clean observation`, async () => {
		let incoming: string | undefined;
		let landing!: FileBoundary;
		const {
			db,
			real,
			base: boundary,
			history,
			write,
			commitOf,
		} = await setup((base) => ({
			readRemoteTracking: async () => incoming,
			// Files land, then the index or branch step fails.
			async publishFastForward(plan): Promise<PublishResult> {
				const applied = await landing.apply(plan.changes);
				expect(applied.error).toBeNull();
				const error = FileError.Io({
					path: '.git/index',
					operation: 'lock',
					cause: 'held',
				}).error;
				if (status === 'partial')
					return {
						status,
						applied: plan.changes.map((change) => ({
							kind: 'write' as const,
							path: change.kind === 'move' ? change.to : change.path,
						})),
						error,
					};
				if (status === 'indexFailed')
					return { status, error: 'index.lock exists' };
				return {
					status,
					actual: await base.readBranch(),
					filesApplied: true,
				};
			},
		}));
		landing = boundary;
		await write('a.txt', 'one');
		await history.commit();
		const head = await real.readBranch();
		incoming = await commitOf(head, { 'a.txt': 'two' });
		const before = await history.status();
		expect(before.data?.changes).toEqual([]);

		const pulled = await history.pullFastForward();
		expect(pulled.error?.name).toBe(
			status === 'partial'
				? 'Partial'
				: status === 'indexFailed'
					? 'IndexFailed'
					: 'BranchMoved',
		);
		const files = history.snapshot.files;
		const freshClean =
			files.state === 'observed' &&
			!files.stale &&
			files.value.changes.length === 0;
		expect(freshClean).toBe(false);
		// The branch did not move; the landed bytes are uncommitted changes.
		expect(await real.readBranch()).toBe(head);
		const after = await history.status();
		expect(after.data?.changes).toEqual([{ path: 'a.txt', kind: 'modify' }]);
		expect(history.snapshot.lastCommit?.status).toBe('committed');
		await history.close();
		db.close();
	});
}

test('explicit commit stays local; managed-save requests and commitAndPush push once per pass', async () => {
	const held = gate();
	let holdNext = false;
	const { db, history, write, pushes } = await setup((real) => ({
		// Hold a pass after it captured files, just before it publishes.
		async casBranch(expected, next) {
			if (holdNext) {
				holdNext = false;
				await held.opened;
			}
			return real.casBranch(expected, next);
		},
	}));
	await write('a.txt', 'one');
	expect((await history.commit()).status).toBe('committed');
	await Bun.sleep(20);
	expect(pushes()).toBe(0);

	await write('a.txt', 'two');
	history.requestAutomaticCommit();
	await until(() => pushes() === 1);

	// An explicit pass is held; automatic and explicit requests coalesce into
	// one pending pass, which pushes exactly once.
	await write('a.txt', 'three');
	holdNext = true;
	const explicit = history.commit();
	await Bun.sleep(5);
	await write('a.txt', 'four');
	history.requestAutomaticCommit();
	history.requestAutomaticCommit();
	const joined = history.commit();
	held.open();
	expect((await explicit).status).toBe('committed');
	expect((await joined).status).toBe('committed');
	await until(() => pushes() === 2);
	await Bun.sleep(20);
	expect(pushes()).toBe(2);

	await write('a.txt', 'five');
	const both = await history.commitAndPush();
	expect(both.commit.status).toBe('committed');
	expect(both.push.status).toBe('pushed');
	expect(pushes()).toBe(3);
	await history.close();
	db.close();
});

test('a managed save still pushes when an explicit pass already captured it', async () => {
	const { db, real, history, write, pushes } = await setup();
	await write('a.txt', 'one');
	await history.commit();
	const held = gate();
	const entered = gate();
	const owner = real.exclusive(async () => {
		entered.open();
		await held.opened;
	});
	await entered.opened;
	const explicit = history.commit();
	await write('a.txt', 'managed save');
	history.requestAutomaticCommit();
	held.open();
	await owner;
	expect((await explicit).status).toBe('committed');
	await until(() => pushes() === 1);
	await until(() => history.snapshot.lastCommit?.status === 'unchanged');
	expect(pushes()).toBe(1);
	await history.close();
	db.close();
});

test('with commitOnEdit false, automatic requests do nothing and commitAndPush still does both', async () => {
	const { db, history, write, pushes } = await setup(() => ({}), {
		commitOnEdit: false,
	});
	await write('a.txt', 'one');
	history.requestAutomaticCommit();
	await Bun.sleep(20);
	expect(history.snapshot.lastCommit).toBeUndefined();
	const both = await history.commitAndPush();
	expect(both.commit.status).toBe('committed');
	expect(both.push.status).toBe('pushed');
	expect(pushes()).toBe(1);
	await history.close();
	db.close();
});
