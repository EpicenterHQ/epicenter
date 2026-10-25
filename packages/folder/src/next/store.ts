/**
 * The one shape every folder read has: a current value and a change notice.
 * It is `useSyncExternalStore`'s contract, so React reads it directly, Svelte
 * adapts it with `createSubscriber`, and a script calls `get()`.
 */
export type Store<T> = {
	get(): T;
	subscribe(onChange: () => void): () => void;
};

/** A store over `get`, and the `notify` that tells its subscribers it changed. */
export function createStore<T>(get: () => T): Store<T> & { notify(): void } {
	const listeners = new Set<() => void>();
	return {
		get,
		subscribe(onChange) {
			listeners.add(onChange);
			return () => listeners.delete(onChange);
		},
		notify() {
			for (const listener of [...listeners]) listener();
		},
	};
}
