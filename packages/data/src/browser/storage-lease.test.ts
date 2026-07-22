/**
 * Browser Storage Lease Tests
 *
 * Verifies acquisition, cancellation, explicit release, and loss notification
 * for the origin-wide Web Lock held by the browser SQLite owner.
 *
 * Key behaviors:
 * - pending acquisition observes cancellation
 * - acquired leases ignore later cancellation until explicit release
 * - stolen leases notify their owner exactly once
 */
import { expect, test } from 'bun:test';

import {
	acquireBrowserStorageLease,
	type LockManagerPort,
} from './storage-lease.js';

function setupStealableLock() {
	let stealHeldLock: ((cause: Error) => void) | undefined;
	const locks: LockManagerPort = {
		request(_name, _options, callback) {
			const stolen = Promise.withResolvers<never>();
			stealHeldLock = (cause) => stolen.reject(cause);
			return Promise.race([callback(), stolen.promise]);
		},
	};
	return {
		locks,
		steal() {
			const steal = stealHeldLock;
			if (steal === undefined) throw new Error('No lock is held');
			stealHeldLock = undefined;
			const cause = new Error('The lock request was stolen');
			cause.name = 'AbortError';
			steal(cause);
		},
	};
}

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
		onStolen: () => undefined,
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
		onStolen: () => undefined,
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

test('a stolen lease notifies its owner once and release remains idempotent', async () => {
	const { locks, steal } = setupStealableLock();
	let losses = 0;
	const lease = await acquireBrowserStorageLease(locks, {
		onStolen: () => {
			losses += 1;
		},
	});

	steal();
	await Bun.sleep(0);
	expect(losses).toBe(1);

	await lease.release();
	await lease.release();
	expect(losses).toBe(1);
});
