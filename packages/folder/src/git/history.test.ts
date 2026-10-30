/**
 * Request cancellation tests.
 * An explicit signal aborts an outgoing transfer without a disposable history
 * handle. The request awaits cancellation and retains its checkpoint receipt.
 */
import { expect, test } from 'bun:test';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { expectOk } from 'wellcrafted/testing';
import { rawDirectoryFolder } from '../directory-history.test-support.js';
import { overwrite } from '../put.test-support.js';
import type { GitBackend } from './backend.js';
import { executeHistoryRequest } from './history.js';

test('aborting a request cancels its push and retains the completed local checkpoint', async () => {
	const raw = await rawDirectoryFolder('history-cancel-');
	const real = await raw.backend({
		remote: { url: 'https://unused.test/r.git', branch: 'main' },
	});
	const started = Promise.withResolvers<void>();
	let settled = false;
	const backend: GitBackend = {
		...real,
		fetch: async () => undefined,
		async push(_oid, signal) {
			started.resolve();
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				}),
			);
			throw new Error('unreachable');
		},
	};
	await overwrite(raw.boundary, 'a.txt', 'saved');
	const controller = new AbortController();
	const { sink } = memorySink();
	const pending = executeHistoryRequest(
		{
			backend,
			boundary: raw.boundary,
			getAuthor: () => ({ name: 'History', email: 'history@example.test' }),
			signal: controller.signal,
			log: createLogger('test/history', sink),
		},
		{ op: 'sync' },
	).then((reply) => {
		settled = true;
		return reply;
	});
	await started.promise;
	expect(settled).toBe(false);
	controller.abort(new Error('cancelled'));
	const reply = await pending;
	expect(expectOk(reply.result)).toMatchObject({
		kind: 'saved',
		push: { status: 'cancelled' },
	});
	expect(reply.state.lastCommit?.status).toBe('committed');
	expect(reply.state.lastPush?.status).toBe('cancelled');
	expect(settled).toBe(true);
});
