/**
 * One pass at a time, with three ways in.
 *
 * `attempt` is for work nobody is waiting on, such as a rescan after a
 * partly landed pull: it starts
 * a pass only when nothing is running or waiting, and otherwise does nothing.
 * The runner keeps no record that it was called, so a skipped attempt never
 * runs later.
 *
 * `request` is for a caller that awaits the result. It waits for the passes
 * ahead of it and then runs its own, so its pass reads inputs no older than
 * the request. Each waiting caller is one pass.
 *
 * `follow` is for callers that only need a pass that starts after they asked.
 * Everyone who asks before that pass starts shares it; nobody joins a pass
 * that is already running, since it may have read its inputs. However many
 * ask during a running pass, one pass follows it.
 *
 * A waiter whose turn comes after closing started gets the closed result
 * without running.
 */

export type PassRunner<TInput, T> = {
	/** Starts a pass and returns its result, or `undefined` when one is running, waiting, or the runner is closed. */
	attempt(input: TInput): Promise<T> | undefined;
	/** Runs a pass after those ahead of it. Resolves with the closed result once closing started. */
	request(input: TInput): Promise<T>;
	/** The result of the one pass that starts after this call and before any later `follow`. */
	follow(input: TInput): Promise<T>;
	readonly active: boolean;
	/**
	 * Refuse new passes, abort the active pass's signal, and wait for that
	 * pass to settle. A pass that ignores its signal runs to its own end.
	 * Callers still waiting for a turn get the closed result.
	 */
	close(): Promise<void>;
};

export function createPassRunner<TInput, T>({
	run,
	failed,
	closed,
	onChange,
}: {
	run: (input: TInput, signal: AbortSignal) => Promise<T>;
	/** Converts an unexpected throw into a result; a pass never rejects. */
	failed: (cause: unknown) => T;
	/** The result for a request that closing reached before its turn. */
	closed: () => T;
	onChange?: () => void;
}): PassRunner<TInput, T> {
	let controller: AbortController | undefined;
	let waiting = 0;
	let fenced = false;
	/** Settles when every pass and waiter so far is done. */
	let tail: Promise<unknown> = Promise.resolve();
	/** The shared pass that has not started yet, if `follow` made one. */
	let follower: Promise<T> | undefined;

	async function pass(input: TInput): Promise<T> {
		controller = new AbortController();
		onChange?.();
		try {
			return await run(input, controller.signal);
		} catch (cause) {
			return failed(cause);
		} finally {
			controller = undefined;
			onChange?.();
		}
	}

	/** Queue one turn; `starting` hears when it begins to run. */
	function enqueue(input: TInput, starting?: () => void): Promise<T> {
		waiting++;
		const result = tail.then(() => {
			waiting--;
			if (fenced) return closed();
			starting?.();
			return pass(input);
		});
		tail = result;
		return result;
	}

	return {
		get active() {
			return controller !== undefined;
		},
		attempt(input) {
			if (fenced || controller !== undefined || waiting > 0) return undefined;
			return enqueue(input);
		},
		request(input) {
			if (fenced) return Promise.resolve(closed());
			return enqueue(input);
		},
		follow(input) {
			if (fenced) return Promise.resolve(closed());
			follower ??= enqueue(input, () => {
				// Starting now: whoever asks from here on needs the next pass.
				follower = undefined;
			});
			return follower;
		},
		async close() {
			fenced = true;
			controller?.abort();
			await tail;
		},
	};
}
