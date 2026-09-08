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

import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import { Ok } from 'wellcrafted/result';
import type { AppSqliteDatabase } from './index.js';
import { DeviceError } from './index.js';
import {
	type AppSqliteRequest,
	answerDevice,
	type DeviceSqliteOwner,
} from './owner.js';

/** sqlite.org's OO1 `DB`, plus the one method the adapter does not carry. */
type PoolDatabase = Parameters<typeof createBrowserSqliteAdapter>[0] & {
	close(): void;
	changes(): number;
};

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
 * pool. The application scope is the filename, exactly as it is for the Bun
 * owner, whose files are `<appId>/<name>` below one root.
 */
const POOL_NAME = 'epicenter';

let installing: Promise<Pool> | undefined;
function poolReady(): Promise<Pool> {
	// The rejection is deliberately not cached: the reason an install fails is
	// another tab holding the directory, and that tab can close. The library
	// caches its own, so the retry has to say so.
	installing ??= install().catch((cause: unknown) => {
		installing = undefined;
		throw cause;
	});
	return installing;
}

async function install(): Promise<Pool> {
	const sqlite3 = (await import('@sqlite.org/sqlite-wasm')).default;
	const module = (await sqlite3()) as unknown as {
		installOpfsSAHPoolVfs(options: {
			name: string;
			forceReinitIfPreviouslyFailed: boolean;
		}): Promise<Pool>;
	};
	return module.installOpfsSAHPoolVfs({
		name: POOL_NAME,
		forceReinitIfPreviouslyFailed: true,
	});
}

/**
 * One live connection per file, and the promise rather than the connection.
 *
 * Caching the promise is what orders an open against a delete of the same name
 * without a queue over everything: a second open joins the first instead of
 * building a second connection over one access handle, and a delete awaits the
 * entry before it closes and unlinks. Names do not order against each other,
 * and nothing asks them to: the Bun owner disclaims it too, and Local Mail's
 * `forgetMail` sequences its own open before its delete (ADR-0321).
 */
const open = new Map<string, Promise<PoolDatabase>>();

function opening(file: string): Promise<PoolDatabase> {
	const existing = open.get(file);
	if (existing !== undefined) return existing;
	const opened = (async () => {
		const pool = await poolReady();
		// A slot is a file, not a connection, so the pool grows with the number of
		// databases this origin has ever held and never shrinks on close. The
		// headroom is for the rollback journal a write transaction creates beside
		// the database, which takes a slot of its own until it commits.
		await pool.reserveMinimumCapacity(pool.getFileCount() + 2);
		return new pool.OpfsSAHPoolDb(file);
	})();
	opened.catch(() => {
		if (open.get(file) === opened) open.delete(file);
	});
	open.set(file, opened);
	return opened;
}

async function closing(file: string): Promise<void> {
	const opened = open.get(file);
	open.delete(file);
	// Settle an open already in flight before closing it, and swallow its
	// failure: a delete of a file that could not be opened is still a delete.
	await opened?.then(
		(database) => database.close(),
		() => undefined,
	);
}

function databaseFilename(
	appId: string,
	scope: import('./protocol.js').StorageScope,
	name: string,
): string {
	const partition =
		scope.kind === 'local'
			? 'local'
			: `account:${scope.authorityId}:${scope.principalId}`;
	// Encode the tuple as one value. Concatenating encoded segments is not
	// injective: (authority=one-two, principal=three) collides with
	// (authority=one, principal=two-three). The filename is an implementation
	// detail, so preserving the tuple's boundaries is more important than
	// mirroring the desktop directory spelling here.
	return `/${encodeURIComponent(JSON.stringify([appId, partition, name]))}.sqlite`;
}

const owner: DeviceSqliteOwner = {
	open: async (appId, scope, name) =>
		sqliteOver(await opening(databaseFilename(appId, scope, name))),
	delete: async (appId, scope, name) => {
		const file = databaseFilename(appId, scope, name);
		// Closed first, because the pool unlinks out from under a live connection
		// without saying so: the connection survives and every statement through
		// it then reports that the tables are gone.
		await closing(file);
		const pool = await poolReady();
		pool.unlink(file);
		// The rollback journal is a file in the pool like any other and `unlink`
		// takes one name, so leaving it behind would hold a slot forever and, on
		// the next open of this name, offer SQLite a journal describing a database
		// that no longer exists.
		pool.unlink(`${file}-journal`);
	},
};

/**
 * One connection as the owner contract states it.
 *
 * `createBrowserSqliteAdapter` already drives OO1's `exec` and `transaction`,
 * so what is left here is the two things it does not carry: a change count,
 * which OO1 answers on the connection rather than the statement, and the
 * `Result` wrapper the application surface is stated in.
 */
function sqliteOver(database: PoolDatabase): AppSqliteDatabase {
	const sqlite = createBrowserSqliteAdapter(database);
	const attempt = <T>(run: () => T) => {
		try {
			return Ok(run());
		} catch (cause) {
			return DeviceError.StorageFailed({ cause });
		}
	};
	return {
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
		self.postMessage({ id, response: await answerDevice(owner, request) });
	} catch (cause) {
		// Only the words cross. An `Error` structured-clones without its subclass
		// and a `DOMException` does not survive at all, so the page rebuilds a
		// failure from this rather than being handed one that lies about what it
		// is.
		self.postMessage({
			id,
			failure: cause instanceof Error ? cause.message : String(cause),
		});
	}
};
