/**
 * An in-process Web Locks API, for runtimes that do not ship one.
 *
 * The same move `fake-indexeddb/auto` makes and for the same reason: the store
 * guards one library against competing producers with `navigator.locks`, that guard is
 * the only one it has, and a test runtime without the API would silently not
 * test it. Supplying the platform is honest; making the production code carry
 * a second mechanism so an absent platform still works is not.
 *
 * Deliberately small. Exclusive mode and `ifAvailable` are the whole of what
 * `library-claim.ts` asks for, so they are the whole of what this provides: a shared
 * lock mode or a waiting queue would be inventing behavior nothing here can
 * observe. Scoped to one process, which is exactly the scope a test has.
 */

type LockRequestOptions = { mode: 'exclusive'; ifAvailable: true };

type LockManager = {
	request(
		name: string,
		options: LockRequestOptions,
		callback: (lock: unknown) => Promise<void> | undefined,
	): Promise<unknown>;
};

/**
 * Install `navigator.locks` when the runtime has none, and report whether it
 * was installed.
 *
 * Idempotent, and it never replaces a real implementation: a browser running
 * these tests should exercise its own.
 */
export function installTestLocks(): boolean {
	const scope = globalThis as {
		navigator?: { locks?: LockManager };
	};
	if (scope.navigator?.locks !== undefined) return false;

	const held = new Set<string>();
	const locks: LockManager = {
		async request(name, _options, callback) {
			if (held.has(name)) {
				// The API hands the callback `null` when `ifAvailable` could not be
				// satisfied, rather than throwing.
				return callback(null);
			}
			held.add(name);
			try {
				// The lock is held for exactly as long as the callback's promise is
				// pending, which is the contract `library-claim.ts` relies on to hold one
				// for a store's whole lifetime.
				return await callback({ name, mode: 'exclusive' });
			} finally {
				held.delete(name);
			}
		},
	};

	if (scope.navigator === undefined) {
		Object.defineProperty(scope, 'navigator', {
			value: {},
			configurable: true,
		});
	}
	Object.defineProperty(scope.navigator as object, 'locks', {
		value: locks,
		configurable: true,
	});
	return true;
}
