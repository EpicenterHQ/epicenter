/// <reference lib="dom" />

/**
 * The page's half of the browser SQLite owner: a worker, and the ids that make
 * `postMessage` answerable.
 *
 * There is no SQLite here at all any more, and there cannot be: OPFS
 * synchronous access handles exist only in a dedicated worker
 * (`browser-sqlite.worker.ts` says what that costs). So this file is what the
 * desktop leaf is with `fetch` swapped for `postMessage`, and both of them
 * carry the same lifetime and connection requests.
 *
 * It holds no map of open databases. The worker owns those, because it owns
 * the connections; a page-side map would be a second answer to "is this file
 * open" that nothing keeps true.
 */

import { DeviceError } from './index.js';
import type { AppSqliteRequest, AppSqliteTransport } from './owner.js';
import type { DeviceResponse } from './protocol.js';

type Answer =
	| { id: number; response: DeviceResponse }
	| { id: number; failure: string };

/**
 * Reach this origin's storage worker, starting it if nothing has yet.
 *
 * Lazy, and that is load-bearing rather than tidy: `browser.ts` builds this at
 * module scope, and a `Worker` constructed there would run in every test and
 * every server render that merely imports the leaf.
 */
function createBrowserSqliteTransport(): AppSqliteTransport {
	let worker: Worker | undefined;
	const pending = new Map<
		number,
		(answer: Answer | { failed: unknown }) => void
	>();
	let nextId = 0;

	function ready(): Worker {
		if (worker !== undefined) return worker;
		const started = new Worker(
			new URL('./browser-sqlite.worker.ts', import.meta.url),
			{ type: 'module' },
		);
		started.onmessage = (event: MessageEvent<Answer>) => {
			const settle = pending.get(event.data.id);
			pending.delete(event.data.id);
			settle?.(event.data);
		};
		// A worker that died took every statement in flight with it, and the ones
		// that had not been sent would wait forever on a thread that is gone. Fail
		// them all and start a new worker on the next call: its pool install is
		// the only thing that can say whether storage is reachable again.
		const abandon = (cause: unknown) => {
			// Late errors from a retired worker cannot fail its replacement's calls.
			if (worker !== started) return;
			worker = undefined;
			started.terminate();
			for (const settle of [...pending.values()]) settle({ failed: cause });
			pending.clear();
		};
		started.onerror = (event) => abandon(event.message ?? 'worker failed');
		started.onmessageerror = () =>
			abandon('the storage worker sent something unreadable');
		worker = started;
		return started;
	}

	return (message: AppSqliteRequest) =>
		new Promise((resolve) => {
			const id = nextId++;
			pending.set(id, (answer) => {
				if ('failed' in answer) {
					resolve(DeviceError.StorageFailed({ cause: answer.failed }));
				} else if ('failure' in answer) {
					resolve(
						DeviceError.StorageFailed({ cause: new Error(answer.failure) }),
					);
				} else {
					resolve({ data: answer.response, error: null });
				}
			});
			try {
				ready().postMessage({ id, request: message });
			} catch (cause) {
				pending.delete(id);
				resolve(DeviceError.StorageFailed({ cause }));
			}
		});
}

// All app owners in this realm share the worker and request IDs, not a pool.
// Constructing the transport performs no I/O; its first request starts it.
export const browserSqliteTransport = createBrowserSqliteTransport();
