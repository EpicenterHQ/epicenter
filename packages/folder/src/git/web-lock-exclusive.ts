import type { OpfsLocks } from '../opfs-store.js';
import type { GitBackend } from './backend.js';

/**
 * A backend's `exclusive` over one Web Lock, shared by every tab or window
 * of the origin. The lock queues this page's requests behind every holder
 * and waiter, and the signal rejects a waiter that is aborted before it is
 * granted; that waiter never runs its work.
 */
export function webLockExclusive(
	locks: OpfsLocks,
	lockName: string,
): GitBackend['exclusive'] {
	return async <T>(work: () => Promise<T>, signal?: AbortSignal) => {
		let entered = false;
		try {
			return await locks.request(lockName, { signal }, () => {
				signal?.throwIfAborted();
				entered = true;
				return work();
			});
		} catch (cause) {
			// Normalize a refused wait even if the host uses its own AbortError.
			if (!entered && signal?.aborted) throw signal.reason;
			throw cause;
		}
	};
}
