/**
 * History Coordinator Close Tests
 *
 * Closing a folder's history must stop outgoing network work at once while
 * the local commit already running finishes. A held local commit must not
 * delay the cancellation.
 *
 * Key behaviors:
 * - `close()` aborts Sync's active push synchronously, and Sync answers
 *   `saved` with the push cancelled
 * - The active local commit still completes, and `close()` waits for it
 * - Anything asked after closing began is told the folder closed
 *
 * See also:
 * - `runner.test.ts` for `attempt` and `request`
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
	const real = await raw.backend({
		remote: { url: 'http://unused.test/remote.git', branch: 'main' },
	});
	const probe = {
		pushStarts: 0,
		pushAborts: 0,
		hold: undefined as Promise<void> | undefined,
	};
	const backend: GitBackend = {
		...real,
		async blocked() {
			await probe.hold;
			return undefined;
		},
		// The remote has no branch yet, so Sync's next step is a push.
		fetch: async () => undefined,
		push(_oid, signal) {
			probe.pushStarts++;
			return new Promise<'pushed' | 'rejected'>((_resolve, reject) =>
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

test('close aborts the active Sync push at once while a held local commit finishes', async () => {
	const { boundary, backend, probe, write } = await setup();
	const history = createHistory({
		backend,
		boundary,
		author,
	});

	await write('a.txt', 'a');
	const first = history.sync.run();
	// The push after that commit is now active and stalled.
	for (let index = 0; index < 100 && probe.pushStarts === 0; index++)
		await Bun.sleep(1);
	expect(history.snapshot.activity.push.active).toBe(true);

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
	expect((await history.sync.run()).error?.name).toBe('Closed');
	expect((await first).data).toMatchObject({
		kind: 'saved',
		push: { status: 'cancelled' },
	});

	await Bun.sleep(10);
	expect(closed).toBe(false);
	release();
	const finished = await local;
	expect(finished.status).toBe('committed');
	await closing;
	expect(history.snapshot.lastPush?.status).toBe('cancelled');
	expect(probe.pushStarts).toBe(1);
});
