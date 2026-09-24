/// <reference lib="webworker" />

/**
 * The browser's SQLite owner, in the one context that can be one.
 *
 * **A worker is not a performance choice here, it is where the API exists.**
 * OPFS synchronous access handles are exposed to dedicated workers and nowhere
 * else: `FileSystemFileHandle.createSyncAccessHandle` is `undefined` on the
 * main thread, with cross-origin isolation and without it, on both engines
 * Epicenter targets. The leaf this replaced called `new sqlite3.oo1.OpfsDb()`
 * from the page, which could never have opened anything.
 *
 * **The VFS is `installOpfsSAHPoolVfs`, not `oo1.OpfsDb`.** Both need a
 * worker; only the second also needs the page cross-origin isolated, which
 * would put `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` on
 * every response that ever serves an Epicenter bundle and break any
 * cross-origin subresource an application renders. The pool asks nothing of
 * the host, so where a build can be served stays a hosting question.
 *
 * Each app/account owns a separate pool directory. Its SQL lifetime closes
 * every database before pausing the pool to release OPFS access handles.
 * Other owners can remain live in this worker or in another window.
 */

import { type AccountIdentity, deviceOwnerPath } from '@epicenter/principal';
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import {
	type AppSqliteRequest,
	createDeviceDispatcher,
	createSqliteOwner,
} from './owner.js';

import { sqliteOver } from './wasm-sqlite.js';

let initializing: Promise<Sqlite3Static> | undefined;
const pools = new Map<string, ReturnType<typeof installPool>>();

function poolName(appId: string, account?: AccountIdentity) {
	return `epicenter-${encodeURIComponent(JSON.stringify([appId, deviceOwnerPath(account)]))}`;
}

function poolReady(appId: string, account?: AccountIdentity) {
	const name = poolName(appId, account);
	let pending = pools.get(name);
	if (!pending) {
		pending = installPool(name).catch((cause: unknown) => {
			pools.delete(name);
			throw cause;
		});
		pools.set(name, pending);
	}
	return pending;
}

async function installPool(name: string) {
	initializing ??= import('@sqlite.org/sqlite-wasm')
		.then(({ default: initialize }) => initialize())
		.catch((cause: unknown) => {
			initializing = undefined;
			throw cause;
		});
	const sqlite = await initializing;
	// SQLite caches registrations, including paused pools. Activate the cached
	// pool when a new lifetime returns to this owner. Old `.epicenter` files
	// remain untouched; this layout does not adopt their data.
	// The installed implementation supports this retry option; its published
	// option type currently omits it.
	const options = {
		name,
		forceReinitIfPreviouslyFailed: true,
	};
	const pool = await sqlite.installOpfsSAHPoolVfs(options);
	await pool.unpauseVfs();
	return { pool, sqlite };
}

function databaseFilename(
	appId: string,
	name: string,
	account?: AccountIdentity,
): string {
	return `/${encodeURIComponent(JSON.stringify([appId, deviceOwnerPath(account), name]))}.sqlite`;
}

const owner = createSqliteOwner({
	async open(appId, name, account) {
		const { pool, sqlite } = await poolReady(appId, account);
		// getFileCount counts assigned filenames, not capacity or connections.
		// Leave room for a journal per database, including transactions held
		// across run() calls.
		// This is capacity allocation, not the exclusive lifetime reservation.
		await pool.reserveMinimumCapacity(2 * (pool.getFileCount() + 1));
		const database = new pool.OpfsSAHPoolDb(
			databaseFilename(appId, name, account),
		);
		return {
			...sqliteOver(database, sqlite),
			async close() {
				database.close();
			},
		};
	},
	async delete(appId, name, account) {
		const file = databaseFilename(appId, name, account);
		const { pool } = await poolReady(appId, account);
		pool.unlink(file);
		pool.unlink(`${file}-journal`);
	},
	async release(appId, account) {
		const name = poolName(appId, account);
		const pending = pools.get(name);
		if (!pending) return;
		const { pool } = await pending;
		pool.pauseVfs();
		pools.delete(name);
	},
});
const dispatch = createDeviceDispatcher(owner);

/**
 * The envelope, which is this transport's alone.
 *
 * `postMessage` has no reply, so an id correlates one. Responses are not in
 * request order, deliberately: a statement on an open connection answers
 * before an open that is still growing the pool, and an array of resolvers
 * would encode that scheduling as an invisible promise across the boundary.
 */
type Envelope = { id: number; request: AppSqliteRequest };

self.onmessage = async (event: MessageEvent<Envelope>) => {
	const { id, request } = event.data;
	try {
		self.postMessage({ id, response: await dispatch.request(request) });
	} catch (cause) {
		// Only the words cross. An `Error` structured-clones without its subclass
		// and a `DOMException` does not survive at all, so the page rebuilds a
		// failure from this rather than being handed one that lies about what it
		// is.
		self.postMessage({
			id,
			failure:
				cause instanceof Error
					? cause.message
					: typeof cause === 'object' &&
							cause !== null &&
							'cause' in cause &&
							cause.cause instanceof Error
						? cause.cause.message
						: String(cause),
		});
	}
};
