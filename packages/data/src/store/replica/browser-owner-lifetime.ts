type BrowserReplicaOwnerState = 'opening' | 'active' | 'disposed';

/**
 * Own the terminal transition between one Web Lock and its SQLite resources.
 *
 * There is no lost-ownership state (ADR-0165). The lock is taken with
 * `ifAvailable`, nothing steals it, and terminating the worker is what ends
 * live ownership, so the only exits from `active` are disposal and worker
 * death.
 */
export function createBrowserReplicaOwnerLifetime({
	closeDatabase,
	pauseVfs,
	releaseLease,
}: {
	closeDatabase(): void;
	pauseVfs(): void;
	releaseLease(): Promise<void>;
}) {
	let state: BrowserReplicaOwnerState = 'opening';
	let disposal: Promise<void> | undefined;
	const physicalCleanupFailures: unknown[] = [];

	function closePhysicalOwner(): void {
		for (const stage of [closeDatabase, pauseVfs]) {
			try {
				stage();
			} catch (cause) {
				physicalCleanupFailures.push(cause);
			}
		}
	}

	function requireOpening(): void {
		if (state !== 'opening') {
			throw new Error(
				`browser replica owner cannot open from state '${state}'`,
			);
		}
	}

	function requireActive(): void {
		switch (state) {
			case 'active':
				return;
			case 'opening':
				throw new Error('browser replica owner is still opening');
			case 'disposed':
				throw new Error('browser replica owner is disposed');
		}
	}

	return {
		requireOpening,
		requireActive,
		activate(): void {
			requireOpening();
			state = 'active';
		},
		async dispose(): Promise<void> {
			disposal ??= (async () => {
				state = 'disposed';
				// SQLite close and SAH-pool pause synchronously release the OPFS
				// access handles, so they land before the lock a successor needs.
				closePhysicalOwner();
				try {
					await releaseLease();
				} catch (cause) {
					physicalCleanupFailures.push(cause);
				}
				if (physicalCleanupFailures.length === 1) {
					throw physicalCleanupFailures[0];
				}
				if (physicalCleanupFailures.length > 1) {
					throw new AggregateError(
						physicalCleanupFailures,
						'Browser replica owner cleanup failed',
					);
				}
			})();
			return disposal;
		},
	};
}
