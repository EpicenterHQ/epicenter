/**
 * History Coordinator Close Tests
 *
 * Closing a folder's history must stop outgoing network work at once while
 * admitted local commit passes finish. A held local pass must not delay the
 * cancellation, and a commit that finishes during close must not start a push.
 *
 * Key behaviors:
 * - `close()` aborts the active push and cancels the queued push synchronously
 * - An admitted local commit pass still completes, and `close()` waits for it
 * - A commit finishing during close requests no push
 * - A caller signal only stops that caller waiting (`stoppedWaiting`)
 *
 * See also:
 * - `runner.test.ts` for the generic one-active/one-pending runner
 * - `browser.test.ts` for a folder-level stalled push
 */
import { expect, test } from 'bun:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
	createBrowserFileBoundary,
	openFolderDatabase,
} from '../browser-store.js';
import { captureVersion } from '../version.js';
import type { GitBackend } from './backend.js';
import { createBrowserGitBackend } from './browser-backend.js';
import { createHistory } from './history.js';

const author = { name: 'History', email: 'history@example.test' };

async function setup() {
	const environment = { indexedDB: new IDBFactory(), IDBKeyRange };
	const db = await openFolderDatabase('epicenter-folder:history', environment);
	const boundary = createBrowserFileBoundary(db, environment);
	const real = await createBrowserGitBackend({
		db,
		environment,
		lockName: 'history',
		branch: 'main',
		remote: undefined,
	});
	const probe = {
		pushStarts: 0,
		pushAborts: 0,
		hold: undefined as Promise<void> | undefined,
	};
	const backend: GitBackend = {
		...real,
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
		async blocked() {
			await probe.hold;
			return undefined;
		},
		push(_oid, signal) {
			probe.pushStarts++;
			return new Promise<void>((_resolve, reject) =>
				signal.addEventListener('abort', () => {
					probe.pushAborts++;
					reject(new Error('aborted'));
				}),
			);
		},
	};
	async function write(path: string, text: string) {
		const bytes = new TextEncoder().encode(text);
		const applied = await boundary.apply([
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
	return { db, boundary, backend, probe, write };
}

test('close cancels queued and active pushes at once while a held local pass drains', async () => {
	const { db, boundary, backend, probe, write } = await setup();
	const history = createHistory({
		backend,
		boundary,
		author,
		commitOnEdit: true,
	});

	await write('a.txt', 'a');
	// A managed save's automatic request commits and then pushes.
	history.requestAutomaticCommit();
	// The automatic push after that commit is now active and stalled.
	for (let index = 0; index < 100 && probe.pushStarts === 0; index++)
		await Bun.sleep(1);
	expect(history.snapshot.activity.push.active).toBe(true);
	const queued = history.push();
	expect(history.snapshot.activity.push.pending).toBe(true);

	let release!: () => void;
	probe.hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	await write('b.txt', 'b');
	const local = history.commit();
	await Bun.sleep(1);
	expect(history.snapshot.activity.commit.active).toBe(true);

	let closed = false;
	const closing = history.close().then(() => {
		closed = true;
	});
	// Cancellation happened synchronously, before any local work settled.
	expect(probe.pushAborts).toBe(1);
	expect(await queued).toEqual({ status: 'cancelled', oid: undefined });

	await Bun.sleep(10);
	expect(closed).toBe(false);
	release();
	const drained = await local;
	expect(drained.status).toBe('committed');
	await closing;
	expect(history.snapshot.lastPush?.status).toBe('cancelled');
	// The commit that finished during close requested no push.
	expect(probe.pushStarts).toBe(1);
	expect(await history.push()).toEqual({ status: 'closed' });
	db.close();
});

test('a caller signal stops waiting without aborting the shared push', async () => {
	const { db, boundary, backend, probe, write } = await setup();
	const history = createHistory({
		backend,
		boundary,
		author,
		commitOnEdit: false,
	});
	await write('a.txt', 'a');
	await history.commit();

	const caller = new AbortController();
	const waiting = history.push({ signal: caller.signal });
	for (let index = 0; index < 100 && probe.pushStarts === 0; index++)
		await Bun.sleep(1);
	caller.abort();
	expect(await waiting).toEqual({ status: 'stoppedWaiting' });
	expect(probe.pushAborts).toBe(0);
	expect(history.snapshot.activity.push.active).toBe(true);

	await history.close();
	expect(probe.pushAborts).toBe(1);
	db.close();
});
