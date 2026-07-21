import { expect, test } from 'bun:test';

import {
	acquireBrowserStorageLease,
	type LockManagerPort,
} from './storage-lease.js';

test('aborting a pending lease acquisition cancels the lock request', async () => {
	let callbackRan = false;
	const locks: LockManagerPort = {
		async request(_name, options, callback) {
			const signal = options.signal;
			if (signal === undefined) throw new Error('Expected an abort signal');
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true,
				});
			});
			callbackRan = true;
			await callback();
		},
	};
	const controller = new AbortController();
	const acquiring = acquireBrowserStorageLease(locks, {
		signal: controller.signal,
	});
	const cause = new Error('Caller disconnected');

	controller.abort(cause);
	await expect(acquiring).rejects.toBe(cause);
	expect(callbackRan).toBe(false);
});

test('aborting after acquisition retains the lock until explicit release', async () => {
	const lockCompleted = Promise.withResolvers<void>();
	const locks: LockManagerPort = {
		async request(_name, _options, callback) {
			await callback();
			lockCompleted.resolve();
		},
	};
	const controller = new AbortController();
	const lease = await acquireBrowserStorageLease(locks, {
		signal: controller.signal,
	});
	let completed = false;
	void lockCompleted.promise.then(() => {
		completed = true;
	});

	controller.abort(new Error('Caller disconnected'));
	await Promise.resolve();
	expect(completed).toBe(false);

	await lease.release();
	expect(completed).toBe(true);
});
