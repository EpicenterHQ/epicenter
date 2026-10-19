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
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { rawDirectoryFolder } from '../directory-history.test-support.js';
import { GIT_ENV } from '../git-http.test-support.js';
import { overwrite } from '../put.test-support.js';
import type { GitBackend } from './backend.js';
import { createHistory } from './history.js';

const author = { name: 'History', email: 'history@example.test' };
const originalGlobal = process.env.GIT_CONFIG_GLOBAL;

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = GIT_ENV.GIT_CONFIG_GLOBAL;
});
afterAll(() => {
	if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
});

async function setup() {
	const raw = await rawDirectoryFolder('history-');
	const boundary = raw.boundary;
	const real = await raw.backend({
		remote: { url: 'https://unused.test/remote.git', branch: 'main' },
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
		await overwrite(boundary, path, text);
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
