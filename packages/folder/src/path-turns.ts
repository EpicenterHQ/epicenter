/**
 * Turns per path within one process: work on a path starts only after every
 * earlier work on that path in this process has settled, and work on other
 * paths runs beside it. A path with nothing running or waiting has no entry,
 * so the map holds only the paths in use.
 */
export function createPathTurns() {
	/** The settling of the last work queued for each path in use. */
	const tails = new Map<string, Promise<void>>();

	return {
		/** Run `work` once every earlier `run` for `path` has settled. */
		async run<T>(path: string, work: () => Promise<T>): Promise<T> {
			const ahead = tails.get(path);
			const turn = Promise.withResolvers<void>();
			tails.set(path, turn.promise);
			await ahead;
			try {
				return await work();
			} finally {
				turn.resolve();
				if (tails.get(path) === turn.promise) tails.delete(path);
			}
		},
		/** How many paths have work running or waiting. */
		inUse() {
			return tails.size;
		},
	};
}
