/**
 * History Ordering and Ownership Tests
 *
 * Counterexamples for how the history coordinator orders captures, owns
 * explicit Git work until close, reacts to incoming changes that landed only
 * partly, and decides which commits push.
 *
 * Key behaviors:
 * - A checkpoint waiting for the Git lock pins its parent and captures files
 *   inside the lock, so it cannot commit an older capture over a newer
 *   incoming head
 * - An external branch move between that pin and publication is retried
 *   onto, never overwritten
 * - A Sync whose files landed but whose branch did not move never leaves a
 *   fresh clean observation behind
 * - Explicit `commit()` never pushes; Sync does, once
 * - An index another program holds does not fail a Sync whose files and
 *   branch landed
 * - An explicit request made during a pass waits and takes its own pass
 *
 * See also:
 * - `history.test.ts` for cancellation of outgoing work on close
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import type { LockingStorage } from '../boundary.js';
import { rawBrowserFolder } from '../browser-storage.test-support.js';
import { overwrite } from '../put.test-support.js';
import type { GitBackend } from './backend.js';
import { createHistory } from './history.js';
import {
	capturedBytes,
	commitParents,
	writeCommitObject,
	writeFilesTree,
} from './objects.js';

const author = { name: 'History', email: 'history@example.test' };
const encoder = new TextEncoder();

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

async function setup(
	overrides: (real: GitBackend) => Partial<GitBackend> = () => ({}),
	options: { boundary?: (base: LockingStorage) => LockingStorage } = {},
) {
	const raw = await rawBrowserFolder({ id: 'ordering' });
	const base = raw.boundary;
	const real = await raw.backend({
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
	});
	let pushStarts = 0;
	const backend: GitBackend = {
		...real,
		async push() {
			pushStarts++;
			return 'pushed';
		},
		...overrides(real),
	};
	const boundary = options.boundary?.(base) ?? base;
	const history = createHistory({ backend, boundary, author });
	async function write(path: string, text: string) {
		await overwrite(base, path, text);
	}
	/** A commit another owner writes: `files` on top of `parent`. */
	function commitOf(parent: string | undefined, files: Record<string, string>) {
		return real.withObjects(async (access) =>
			writeCommitObject(access, {
				tree: await writeFilesTree(
					access,
					await capturedBytes(
						new Map(
							Object.entries(files).map(([path, text]) => [
								path,
								encoder.encode(text),
							]),
						),
					),
				),
				parents: parent === undefined ? [] : [parent],
				message: 'Another owner',
				author,
			}),
		);
	}
	return {
		raw,
		real,
		base,
		history,
		write,
		commitOf,
		pushes: () => pushStarts,
	};
}

test('a checkpoint waiting for the Git lock cannot revert files and a head that landed meanwhile', async () => {
	const { real, history, write, commitOf } = await setup();
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
});

test('an external branch move after the parent is pinned is retried onto it, not overwritten', async () => {
	let arm = false;
	let competitor: string | undefined;
	const { real, history, write, commitOf } = await setup(() => ({}), {
		boundary: (base) => ({
			...base,
			async list() {
				const captured = await base.list();
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
	// The retry captured the folder again and committed it on the competitor.
	expect(outcome.status).toBe('committed');
	if (outcome.status === 'committed') {
		expect(await real.readBranch()).toBe(outcome.oid);
		expect(
			await real.withObjects((access) => commitParents(access, outcome.oid)),
		).toEqual([competitor!]);
	}
	await history.close();
});

test('a Sync whose files landed but whose branch did not move invalidates the clean observation', async () => {
	let incoming: string | undefined;
	const { real, history, write, commitOf } = await setup((backend) => ({
		fetch: async () => incoming,
		// Files land, then the branch step finds another program moved it.
		async casBranch(expected, next) {
			if (next === incoming) return { ok: false, actual: 'f'.repeat(40) };
			return backend.casBranch(expected, next);
		},
	}));
	await write('a.txt', 'one');
	await history.commit();
	const head = await real.readBranch();
	incoming = await commitOf(head, { 'a.txt': 'two' });
	const { data: before, error: beforeError } = await history.status();
	expect(beforeError).toBeNull();
	expect(before?.changes).toEqual([]);

	const { error: syncError } = await history.sync.run();
	expect(syncError?.name).toBe('Blocked');
	const files = history.snapshot.files;
	const freshClean =
		files.state === 'observed' &&
		!files.stale &&
		files.value.changes.length === 0;
	expect(freshClean).toBe(false);
	// The branch did not move; the landed bytes are uncommitted changes.
	expect(await real.readBranch()).toBe(head);
	const { data: after, error: afterError } = await history.status();
	expect(afterError).toBeNull();
	expect(after?.changes).toEqual([{ path: 'a.txt', kind: 'modify' }]);
	// Sync's checkpoint found nothing to record before it published.
	expect(history.snapshot.lastCommit?.status).toBe('unchanged');
	await history.close();
});

test('explicit commit stays local; a commit requested during a held pass waits and takes its own; Sync pushes once', async () => {
	const held = gate();
	let holdNext = false;
	const { history, write, pushes } = await setup((real) => ({
		// An empty remote, so Sync's next step is a push.
		fetch: async () => undefined,
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

	// An explicit pass is held after its capture. A second request waits for
	// it and then captures what was saved meanwhile.
	await write('a.txt', 'three');
	holdNext = true;
	const explicit = history.commit();
	await Bun.sleep(5);
	await write('a.txt', 'four');
	const second = history.commit();
	held.open();
	expect((await explicit).status).toBe('committed');
	expect(await second).toMatchObject({
		status: 'committed',
		message: 'Update a.txt',
	});
	await Bun.sleep(20);
	expect(pushes()).toBe(0);

	await write('a.txt', 'five');
	expect(expectOk(await history.sync.run()).kind).toBe('synced');
	expect(pushes()).toBe(1);
	await history.close();
});

test('a published checkpoint keeps its receipt when the following observation fails', async () => {
	let failRead = false;
	let publications = 0;
	const { real, history, write } = await setup((base) => ({
		async casBranch(expected, next) {
			const result = await base.casBranch(expected, next);
			if (result.ok) {
				publications++;
				failRead = true;
			}
			return result;
		},
		async readBranch() {
			if (failRead) throw new Error('post-publication observation unavailable');
			return base.readBranch();
		},
	}));
	try {
		await write('saved.md', 'the save remains readable');
		expectOk(await history.status());
		const outcome = await history.commit();
		expect(outcome.status).toBe('committed');
		if (outcome.status !== 'committed')
			throw new Error('Expected commit receipt');
		expect(await real.readBranch()).toBe(outcome.oid);
		expect(outcome.indexWarning).toBeUndefined();
		expect(history.snapshot.lastCommit).toMatchObject(outcome);
		expect(history.snapshot.files).toMatchObject({
			state: 'observed',
			stale: true,
			error: 'post-publication observation unavailable',
		});
		expect(history.snapshot.sync).toMatchObject({
			state: 'observed',
			stale: true,
		});
		expect(publications).toBe(1);
		failRead = false;
		const observed = expectOk(await history.status());
		expect(observed.head).toBe(outcome.oid);
		expect(observed.changes).toEqual([]);
		expect(history.snapshot.files).toMatchObject({
			stale: false,
			error: undefined,
		});
		expect((await history.commit()).status).toBe('unchanged');
		expect(publications).toBe(1);
	} finally {
		await history.close();
	}
});

test('a published fast-forward stays successful when its observation cannot be refreshed', async () => {
	let incoming: string | undefined;
	let failRead = false;
	const { real, base, history, write, commitOf } = await setup((backend) => ({
		fetch: async () => incoming,
		async casBranch(expected, next) {
			const result = await backend.casBranch(expected, next);
			if (result.ok && next === incoming) failRead = true;
			return result;
		},
		async readBranch() {
			if (failRead) throw new Error('post-pull observation unavailable');
			return backend.readBranch();
		},
	}));
	try {
		await write('saved.md', 'before');
		await history.commit();
		const parent = await real.readBranch();
		incoming = await commitOf(parent, { 'saved.md': 'after' });
		expectOk(await history.status());
		expect(expectOk(await history.sync.run())).toEqual({
			kind: 'synced',
			head: incoming,
		});
		expect(
			new TextDecoder().decode(expectOk(await base.read('saved.md')).bytes),
		).toBe('after');
		// What follows the publish could not read the branch, so nothing
		// claims the folder is clean.
		const files = history.snapshot.files;
		expect(files.state === 'observed' && !files.stale).toBe(false);
		failRead = false;
		expect(await real.readBranch()).toBe(incoming);
	} finally {
		await history.close();
	}
});

test('a branch read failure before publication remains a failed checkpoint', async () => {
	let failRead = false;
	let publications = 0;
	const { real, history, write } = await setup((base) => ({
		async readBranch() {
			if (failRead) throw new Error('pre-publication branch unavailable');
			return base.readBranch();
		},
		async casBranch(expected, next) {
			publications++;
			return base.casBranch(expected, next);
		},
	}));
	try {
		await write('saved.md', 'saved without a commit');
		failRead = true;
		expect(await history.commit()).toEqual({
			status: 'failed',
			error: 'pre-publication branch unavailable',
		});
		expect(await real.readBranch()).toBeUndefined();
		expect(publications).toBe(0);
	} finally {
		await history.close();
	}
});

test('an index another program holds does not fail a Sync whose files and branch landed', async () => {
	let incoming: string | undefined;
	const { real, base, history, write, commitOf } = await setup((backend) => ({
		fetch: async () => incoming,
		async reconcileIndex(commit) {
			if (commit === incoming) throw new Error('index.lock exists');
			return backend.reconcileIndex(commit);
		},
	}));
	try {
		await write('saved.md', 'before');
		await history.commit();
		incoming = await commitOf(await real.readBranch(), { 'saved.md': 'after' });
		expect(expectOk(await history.sync.run())).toEqual({
			kind: 'synced',
			head: incoming,
		});
		expect(await real.readBranch()).toBe(incoming);
		expect(
			new TextDecoder().decode(expectOk(await base.read('saved.md')).bytes),
		).toBe('after');
	} finally {
		await history.close();
	}
});
