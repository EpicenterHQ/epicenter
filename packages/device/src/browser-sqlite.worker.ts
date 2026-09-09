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
 * **A pool owns its directory exclusively, so a second tab has no storage.**
 * Measured on both engines: the second tab's install throws (Chromium
 * `NoModificationAllowedError`, WebKit `InvalidStateError`) and the first
 * tab's databases are untouched and survive a relaunch. The engines disagree
 * about the words, so the page turns it into one sentence rather than showing
 * either. The library caches a failed install per VFS name, which is why the
 * retry below asks it not to.
 */

import type { LibraryReplicaIdentity } from '@epicenter/principal';
import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { Ok, tryAsync } from 'wellcrafted/result';
import { createBrowserQuery } from './browser-query.js';
import type { AppSqliteDatabase } from './index.js';
import { DeviceError } from './index.js';
import {
	type AppSqliteRequest,
	createDeviceDispatcher,
	createSqliteOwner,
} from './owner.js';

type PoolDatabase = Database;

type Pool = {
	OpfsSAHPoolDb: new (filename: string) => PoolDatabase;
	getFileCount(): number;
	reserveMinimumCapacity(minimum: number): Promise<number>;
	unlink(filename: string): boolean;
};

/**
 * Every Epicenter database in this origin, in one pool.
 *
 * One pool rather than one per application, because a pool is an exclusive
 * claim on an OPFS directory and a second install is a refusal, not a second
 * pool. The filename identifies the application, account, and database, just
 * as the Bun owner's directory path does below one root.
 */
const POOL_NAME = 'epicenter';

let installing: Promise<{ pool: Pool; sqlite: Sqlite3Static }> | undefined;
function poolReady(): Promise<{ pool: Pool; sqlite: Sqlite3Static }> {
	// The rejection is deliberately not cached: the reason an install fails is
	// another tab holding the directory, and that tab can close. The library
	// caches its own, so the retry has to say so.
	installing ??= install().catch((cause: unknown) => {
		installing = undefined;
		throw cause;
	});
	return installing;
}

async function install() {
	const initialize = (await import('@sqlite.org/sqlite-wasm')).default;
	const sqlite = await initialize();
	const options = { name: POOL_NAME, forceReinitIfPreviouslyFailed: true };
	const pool = await sqlite.installOpfsSAHPoolVfs(options);
	return { pool, sqlite };
}

function databaseFilename(
	appId: string,
	replica: LibraryReplicaIdentity,
	name: string,
): string {
	const address =
		replica.library === 'local'
			? [appId, 'local', name]
			: [
					appId,
					'account',
					replica.account.authorityId,
					replica.account.principalId,
					...(replica.library === 'shared' ? ['shared'] : []),
					name,
				];
	// Keep every identity component separate before encoding. Joining even
	// part of the address with ':' aliases accounts whose identifiers contain it.
	return `/${encodeURIComponent(JSON.stringify(address))}.sqlite`;
}

// Capacity reservation and file allocation share the pool across app lifetimes.
let poolOperations: Promise<unknown> = Promise.resolve();
function inPool<T>(operation: () => Promise<T>): Promise<T> {
	const result = poolOperations.then(operation);
	poolOperations = result.catch(() => undefined);
	return result;
}

const owner = createSqliteOwner({
	open(appId, replica, name) {
		return inPool(async () => {
			const { pool, sqlite } = await poolReady();
			await pool.reserveMinimumCapacity(pool.getFileCount() + 2);
			const database = new pool.OpfsSAHPoolDb(
				databaseFilename(appId, replica, name),
			);
			return {
				...sqliteOver(database, sqlite),
				async close() {
					database.close();
				},
			};
		});
	},
	delete(appId, replica, name) {
		return inPool(async () => {
			const file = databaseFilename(appId, replica, name);
			const { pool } = await poolReady();
			pool.unlink(file);
			pool.unlink(`${file}-journal`);
		});
	},
});
const dispatch = createDeviceDispatcher(owner);

/**
 * One connection as the owner contract states it.
 *
 * `createBrowserSqliteAdapter` already drives OO1's `exec` and `transaction`,
 * so what is left here is the two things it does not carry: a change count,
 * which OO1 answers on the connection rather than the statement, and the
 * `Result` wrapper the application surface is stated in.
 */
function sqliteOver(
	database: PoolDatabase,
	module: Sqlite3Static,
): AppSqliteDatabase {
	const query = createBrowserQuery(module, database);
	const sqlite = createBrowserSqliteAdapter(database);
	const attempt = <T>(run: () => T) => {
		try {
			return Ok(run());
		} catch (cause) {
			return DeviceError.StorageFailed({ cause });
		}
	};
	return {
		query: (sql, options) =>
			tryAsync({
				try: () => query(sql, options),
				catch: (cause) => DeviceError.StorageFailed({ cause }),
			}),
		run: async (sql, parameters) =>
			attempt(() => {
				sqlite.run(sql, parameters);
				return { changes: database.changes() };
			}),
		all: async (sql, parameters) => attempt(() => sqlite.all(sql, parameters)),
		batch: async (statements) =>
			attempt(() =>
				sqlite.transaction(() => ({
					changes: statements.map((statement) => {
						sqlite.run(statement.sql, statement.parameters);
						return database.changes();
					}),
				})),
			),
	};
}

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
