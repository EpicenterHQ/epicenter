export type BrowserStorageLease = {
	release(): Promise<void>;
};

type LockManagerPort = {
	request(
		name: string,
		options: { mode: 'exclusive'; ifAvailable: true },
		callback: (lock: unknown | null) => Promise<void>,
	): Promise<void>;
};

/**
 * The named refusal a second same-origin owner receives (ADR-0165).
 *
 * An origin admits one live replica owner. A refused page does not queue,
 * poll, retry on focus, or become a follower, so this is a product answer the
 * application presents, not a transient error to swallow.
 */
export class BrowserReplicaAlreadyOpenError extends Error {
	override readonly name = 'BrowserReplicaAlreadyOpen';
	/** The origin-scoped lock that is already held. Diagnostic, not for display. */
	readonly lockName: string;
	constructor(lockName: string) {
		super('This data is already open in another tab or window.');
		this.lockName = lockName;
	}
}

/**
 * Take the one exclusive Web Lock that admits an OPFS SQLite owner.
 *
 * `ifAvailable` is what makes the refusal immediate: the lock manager answers
 * with `null` rather than queueing, so a second owner fails at startup instead
 * of appearing hung for the lifetime of the page that holds it. Nothing steals
 * this lock, so a granted lease is held until its owner releases it.
 */
export async function acquireBrowserStorageLease(
	locks: LockManagerPort,
	{ name = 'epicenter-data-sqlite' }: { name?: string } = {},
): Promise<BrowserStorageLease> {
	const acquired = Promise.withResolvers<BrowserStorageLease>();
	const released = Promise.withResolvers<void>();
	let isReleased = false;

	function finishRelease(): void {
		if (isReleased) return;
		isReleased = true;
		released.resolve();
	}

	const completion = locks.request(
		name,
		{ mode: 'exclusive', ifAvailable: true },
		async (lock) => {
			if (lock === null) {
				acquired.reject(new BrowserReplicaAlreadyOpenError(name));
				return;
			}
			acquired.resolve(
				Object.freeze({
					async release() {
						finishRelease();
						await completion.catch(() => undefined);
					},
				}),
			);
			await released.promise;
		},
	);

	void completion.catch((cause: unknown) => {
		finishRelease();
		acquired.reject(cause);
	});
	return acquired.promise;
}

export type { LockManagerPort };
