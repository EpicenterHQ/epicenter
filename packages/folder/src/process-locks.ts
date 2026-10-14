/**
 * Web Locks for one process that has none, such as Bun.
 *
 * Every holder of the returned manager shares it. A request waits its turn
 * behind earlier requests for the same name. A `signal` that aborts while the
 * request still waits rejects it and its callback never runs; once granted,
 * the signal changes nothing. Other processes are not excluded: a script and a
 * desktop window on one directory coordinate only through Git's own lock
 * files (ADR-0533).
 */
import type { OpfsLocks } from './opfs-store.js';

type Lock = { name: string };
type Work<T> = (lock: Lock) => Promise<T> | T;
type Options = { signal?: AbortSignal };

export function createProcessLocks(): OpfsLocks & {
	request<T>(name: string, work: Work<T>): Promise<T>;
} {
	const tails = new Map<string, Promise<unknown>>();
	return {
		request<T>(
			name: string,
			optionsOrWork: Options | Work<T>,
			maybeWork?: Work<T>,
		): Promise<T> {
			const work = (
				typeof optionsOrWork === 'function' ? optionsOrWork : maybeWork
			) as Work<T>;
			const options = typeof optionsOrWork === 'function' ? {} : optionsOrWork;
			const { signal } = options;
			if (signal?.aborted) return Promise.reject(signal.reason);
			let granted = false;
			const turn = async () => {
				if (signal?.aborted) throw signal.reason;
				granted = true;
				return work({ name });
			};
			const result = (tails.get(name) ?? Promise.resolve()).then(turn, turn);
			tails.set(name, result);
			if (signal === undefined) return result;
			return new Promise<T>((resolve, reject) => {
				signal.addEventListener('abort', () => {
					if (!granted)
						reject(new DOMException('Lock wait aborted', 'AbortError'));
				});
				result.then(resolve, reject);
			});
		},
	};
}
