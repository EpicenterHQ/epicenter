/**
 * History Coordinator Close Tests
 *
 * Closing a folder's history must stop outgoing network work at once while
 * the local commit pass already running finishes. A held local pass must not
 * delay the cancellation, and a commit that finishes during close must not
 * start a push.
 *
 * Key behaviors:
 * - `close()` aborts the active push synchronously
 * - A push requested while one is active waits, and is told the folder
 *   closed when closing reaches it first
 * - The active local commit pass still completes, and `close()` waits for it
 * - A commit finishing during close starts no push
 * - A caller signal only stops that caller waiting (`stoppedWaiting`)
 *
 * See also:
 * - `runner.test.ts` for `attempt` and `request`
 * - `history-attempt.test.ts` for commit attempts and queued callers
 * - `browser.test.ts` for a folder-level stalled push
 */
import { expect, test } from 'bun:test';
import { rawBrowserFolder } from '../browser-storage.test-support.js';
import { hashBytes } from '../capture.js';
import type { GitBackend } from './backend.js';
import { createHistory } from './history.js';

const author = { name: 'History', email: 'history@example.test' };

async function setup() {
	const raw = await rawBrowserFolder({ id: 'history' });
	const boundary = raw.boundary;
	const real = await raw.backend();
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
		const { error: applyError } = await boundary.apply([
			{ kind: 'overwrite', path, bytes, sha256: await hashBytes(bytes) },
		]);
		expect(applyError).toBeNull();
	}
	return { boundary, backend, probe, write };
}

test('close aborts the active push at once while a held local pass finishes', async () => {
	const { boundary, backend, probe, write } = await setup();
	const history = createHistory({
		backend,
		boundary,
		author,
	});

	await write('a.txt', 'a');
	const first = history.commitAndPush();
	// The push after that commit is now active and stalled.
	for (let index = 0; index < 100 && probe.pushStarts === 0; index++)
		await Bun.sleep(1);
	expect(history.snapshot.activity.push.active).toBe(true);
	// A second push waits its turn behind the stalled one.
	const waiting = history.push();
	await Bun.sleep(5);
	expect(probe.pushStarts).toBe(1);

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
	expect((await history.commit()).status).toBe('closed');
	// The aborted push reports that; the one still waiting never started.
	expect((await first).push.status).toBe('cancelled');
	expect(await waiting).toEqual({ status: 'closed' });

	await Bun.sleep(10);
	expect(closed).toBe(false);
	release();
	const finished = await local;
	expect(finished.status).toBe('committed');
	await closing;
	expect(history.snapshot.lastPush?.status).toBe('cancelled');
	// The commit that finished during close started no push.
	expect(probe.pushStarts).toBe(1);
	expect(await history.push()).toEqual({ status: 'closed' });
});

test('a caller signal stops waiting without aborting the shared push', async () => {
	const { boundary, backend, probe, write } = await setup();
	const history = createHistory({
		backend,
		boundary,
		author,
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
});
