type AsyncDisposableSession = {
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Own one route-scoped asynchronous session from its first pending operation
 * through disposal, including the resolve-after-unmount race.
 */
export function createWhisperingUiSessionOpening<
	TSession extends AsyncDisposableSession,
>(open: (signal: AbortSignal) => Promise<TSession>) {
	const controller = new AbortController();
	let session: TSession | undefined;
	let disposed = false;

	const opening = (async () => {
		const created = await open(controller.signal);
		if (disposed) {
			// Disposal ran while `open` was in flight and found no session to
			// close, so this late arrival is ours to release. Disposal sets
			// `disposed` and aborts in the same synchronous step, so the abort
			// reason is always populated here.
			await created[Symbol.asyncDispose]();
			throw controller.signal.reason;
		}
		session = created;
		return created;
	})();

	let disposal: Promise<void> | undefined;
	return {
		opening,
		[Symbol.asyncDispose]() {
			disposal ??= (async () => {
				disposed = true;
				controller.abort();
				await session?.[Symbol.asyncDispose]();
			})();
			return disposal;
		},
	};
}
