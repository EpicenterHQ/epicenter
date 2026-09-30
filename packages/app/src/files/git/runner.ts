/**
 * One active pass and at most one pending pass.
 *
 * An idle runner starts a request immediately; there is no quiet-period timer.
 * A request made while a pass is active joins the single pending pass, which
 * starts when the active one settles. The active pass may already have read
 * its inputs, so a request never joins it. Coalescing bounds the backlog, not
 * the pass frequency.
 */

export type PassRunner<T> = {
	/** Resolves with the result of the pass that starts at or after this request. */
	request(): Promise<T>;
	readonly active: boolean;
	readonly pending: boolean;
	/**
	 * Fence new requests. `drain` lets the active and pending passes run.
	 * `cancel` resolves the pending pass as cancelled without running it and
	 * aborts the active pass's signal; the returned promise still waits for the
	 * active pass to settle.
	 */
	close(mode: 'drain' | 'cancel'): Promise<void>;
};

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

export function createPassRunner<T>({
	run,
	failed,
	closed,
	cancelled,
	onChange,
}: {
	run: (signal: AbortSignal) => Promise<T>;
	/** Converts an unexpected throw into a result; a pass never rejects. */
	failed: (cause: unknown) => T;
	/** The result for a request made after closing started. */
	closed: () => T;
	/** The result of a pending pass cancelled by `close('cancel')`. */
	cancelled: () => T;
	onChange?: () => void;
}): PassRunner<T> {
	let current: { promise: Promise<T>; controller: AbortController } | undefined;
	let next: Deferred<T> | undefined;
	let fenced = false;
	let settled = Promise.resolve();

	function start(): Promise<T> {
		const controller = new AbortController();
		const promise = (async () => {
			try {
				return await run(controller.signal);
			} catch (cause) {
				return failed(cause);
			}
		})();
		current = { promise, controller };
		onChange?.();
		settled = promise.then(async () => {
			current = undefined;
			const waiting = next;
			next = undefined;
			if (waiting !== undefined) {
				waiting.resolve(await start());
				await settled;
			} else onChange?.();
		});
		return promise;
	}

	return {
		get active() {
			return current !== undefined;
		},
		get pending() {
			return next !== undefined;
		},
		request() {
			if (fenced) return Promise.resolve(closed());
			if (current === undefined) return start();
			if (next === undefined) {
				next = deferred<T>();
				onChange?.();
			}
			return next.promise;
		},
		async close(mode) {
			fenced = true;
			if (mode === 'cancel') {
				const waiting = next;
				next = undefined;
				waiting?.resolve(cancelled());
				current?.controller.abort();
			}
			// A pending pass started by the drain replaces `settled`; loop until idle.
			while (current !== undefined || next !== undefined) await settled;
			onChange?.();
		},
	};
}
