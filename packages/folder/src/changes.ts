/**
 * The listeners of one source of change hints, shared by the device stores
 * and the remote client: the source starts with the first listener and stops
 * with the last, and a hint names the paths that changed, or null when the
 * source cannot say.
 */

import type { CompiledContract } from '@epicenter/definition/contract';

/** Hear that files changed: their paths, or null for "something may have". */
export type ChangeListener = (paths: readonly string[] | null) => void;

/** Start hearing `emit`'s hints; returns the function that stops. */
export type ChangeSource = (emit: ChangeListener) => () => void;

/**
 * The listeners of `source`. `emit` also reaches them directly, for a change
 * a client made itself. A listener that throws does not stop the others, nor
 * the write that emitted: its error is thrown again on its own.
 */
export function createChanges(source: ChangeSource = () => () => {}) {
	const listeners = new Set<ChangeListener>();
	let stop: (() => void) | undefined;

	function emit(paths: readonly string[] | null) {
		for (const listener of [...listeners])
			try {
				listener(paths);
			} catch (error) {
				queueMicrotask(() => {
					throw error;
				});
			}
	}

	return {
		emit,
		watch(listener: ChangeListener) {
			listeners.add(listener);
			if (listeners.size === 1) stop = source(emit);
			return () => {
				if (!listeners.delete(listener) || listeners.size > 0) return;
				stop?.();
				stop = undefined;
			};
		},
	};
}

/**
 * `listener`, run for a change that may touch `collection`'s files: one
 * naming a path the contract gives it, or one that cannot say (null).
 */
export function forCollection(
	compiled: CompiledContract,
	collection: string,
	listener: () => void,
): ChangeListener {
	return (paths) => {
		if (
			paths === null ||
			paths.some((path) => compiled.claim(path)?.collection.name === collection)
		)
			listener();
	};
}
