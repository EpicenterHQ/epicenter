/**
 * `@epicenter/folder/serve`: a program's half of a served directory
 * (ADR-0784), in Bun or Node. The program owns a directory on this
 * computer and answers its page's store verbs over it, so the page's
 * folder (`served(url)` from `@epicenter/folder/served`) reads and writes
 * the directory through the program. See `served/wire.ts`.
 *
 * ```ts
 * const folder = serveDirectory('/path/to/drafts');
 * Bun.serve({
 *   fetch(request) {
 *     // after checking the request is the program's own page's:
 *     if (new URL(request.url).pathname.startsWith('/folder/')) return folder.fetch(request);
 *     ...
 *   },
 * });
 * ```
 */
import { mkdir, stat } from 'node:fs/promises';
import { ClientError } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { nodeStore } from './device/node-store.js';
import { type StoreHandler, storeHandler } from './served/handler.js';

export type { StoreHandler } from './served/handler.js';

/**
 * Answer the served wire over the directory at `path`, made with its
 * missing parents at the first request; a request while it cannot be made
 * answers that the store is unavailable, and the next tries again. The
 * caller decides which requests are its page's; this answers any it is
 * given, by the last segment of its path (`/folder/list`: `list`).
 */
export function serveDirectory(path: string): StoreHandler {
	return storeHandler(async () => {
		try {
			await mkdir(path, { recursive: true });
			if (!(await stat(path)).isDirectory())
				return ClientError.Unavailable({ cause: `${path} is not a directory` });
		} catch (cause) {
			return ClientError.Unavailable({ cause });
		}
		return Ok(nodeStore(path));
	});
}
