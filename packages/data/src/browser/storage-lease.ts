export type BrowserStorageLease = {
	release(): Promise<void>;
};

type LockManagerPort = {
	request(
		name: string,
		options: { mode: 'exclusive'; signal?: AbortSignal },
		callback: () => Promise<void>,
	): Promise<void>;
};

/** Retain one exclusive Web Lock for the OPFS SQLite owner. */
export async function acquireBrowserStorageLease(
	locks: LockManagerPort,
	{
		onStolen = () => undefined,
		signal,
	}: { onStolen?: () => void; signal?: AbortSignal } = {},
): Promise<BrowserStorageLease> {
	signal?.throwIfAborted();
	const acquired = Promise.withResolvers<BrowserStorageLease>();
	const released = Promise.withResolvers<void>();
	let isAcquired = false;
	let isReleased = false;

	function finishRelease(): void {
		if (isReleased) return;
		isReleased = true;
		released.resolve();
	}

	const completion = locks.request(
		'epicenter-data-sqlite',
		{ mode: 'exclusive', ...(signal === undefined ? {} : { signal }) },
		async () => {
			isAcquired = true;
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

	void completion.catch((cause) => {
		if (!isAcquired) {
			acquired.reject(cause);
			return;
		}
		const wasReleased = isReleased;
		finishRelease();
		if (!wasReleased) onStolen();
	});
	return acquired.promise;
}

export type { LockManagerPort };
