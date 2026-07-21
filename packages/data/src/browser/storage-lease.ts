export type BrowserStorageLease = {
	release(): Promise<void>;
};

type LockManagerPort = {
	request(
		name: string,
		options: { mode: 'exclusive'; steal: true },
		callback: () => Promise<void>,
	): Promise<void>;
};

/** Retain one stealable exclusive Web Lock for the OPFS SQLite owner. */
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

	function abort(): void {
		acquired.reject(signal?.reason);
		finishRelease();
	}

	signal?.addEventListener('abort', abort, { once: true });

	const completion = locks.request(
		'epicenter-data-sqlite',
		{ mode: 'exclusive', steal: true },
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
	void completion.then(
		() => signal?.removeEventListener('abort', abort),
		() => signal?.removeEventListener('abort', abort),
	);
	return acquired.promise;
}

export type { LockManagerPort };
