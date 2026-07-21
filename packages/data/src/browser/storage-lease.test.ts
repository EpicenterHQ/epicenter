import { expect, test } from 'bun:test';

import {
	acquireBrowserStorageLease,
	type LockManagerPort,
} from './storage-lease.js';

test('aborting lease acquisition rejects the caller and releases a late lock', async () => {
	const allowLock = Promise.withResolvers<void>();
	const lockCompleted = Promise.withResolvers<void>();
	let stolen = false;
	const locks: LockManagerPort = {
		async request(_name, _options, callback) {
			try {
				await allowLock.promise;
				await callback();
			} finally {
				lockCompleted.resolve();
			}
		},
	};
	const controller = new AbortController();
	const acquiring = acquireBrowserStorageLease(locks, {
		onStolen: () => {
			stolen = true;
		},
		signal: controller.signal,
	});
	const cause = new Error('Caller disconnected');

	controller.abort(cause);
	await expect(acquiring).rejects.toBe(cause);
	allowLock.resolve();
	await lockCompleted.promise;
	expect(stolen).toBe(false);
});
