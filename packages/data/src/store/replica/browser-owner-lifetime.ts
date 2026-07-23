const OWNER_LOST_ERROR_NAME = 'EpicenterBrowserOwnerLostError';

type BrowserReplicaOwnerState =
	| 'opening'
	| 'active'
	| 'owner-lost'
	| 'disposed';

function ownerLostError(failures: readonly unknown[]): Error {
	const error = new Error('Browser replica storage moved to a newer owner', {
		...(failures.length === 0
			? {}
			: {
					cause: new AggregateError(
						failures,
						'Browser replica physical-owner cleanup failed',
					),
				}),
	});
	error.name = OWNER_LOST_ERROR_NAME;
	return error;
}

/** Own the terminal transition between one Web Lock and its SQLite resources. */
export function createBrowserReplicaOwnerLifetime({
	stopSources,
	closeDatabase,
	pauseVfs,
	releaseLease,
}: {
	stopSources(): void;
	closeDatabase(): void;
	pauseVfs(): void;
	releaseLease(): Promise<void>;
}) {
	let state: BrowserReplicaOwnerState = 'opening';
	let disposal: Promise<void> | undefined;
	const physicalCleanupFailures: unknown[] = [];

	function closePhysicalOwner(): void {
		for (const stage of [stopSources, closeDatabase, pauseVfs]) {
			try {
				stage();
			} catch (cause) {
				physicalCleanupFailures.push(cause);
			}
		}
	}

	function requireOpening(): void {
		if (state === 'owner-lost') throw ownerLostError(physicalCleanupFailures);
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
			case 'owner-lost':
				throw ownerLostError(physicalCleanupFailures);
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
		ownerLost(): void {
			if (state === 'owner-lost' || state === 'disposed') return;
			state = 'owner-lost';
			// A thief may already hold the logical Web Lock. SQLite close and
			// SAH-pool pause synchronously release the OPFS access handles that
			// remain the physical no-overlap fence until this callback returns.
			closePhysicalOwner();
		},
		async dispose(): Promise<void> {
			disposal ??= (async () => {
				if (state !== 'owner-lost') state = 'disposed';
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
