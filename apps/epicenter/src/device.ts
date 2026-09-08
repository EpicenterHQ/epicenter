/** Bun-owned application SQLite files. The application never receives this owner. */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appDataDir, isAppId } from '@epicenter/constants/app-data';
import { type AppSqliteDatabase, DeviceError } from '@epicenter/device';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import type { AccountIdentity } from '@epicenter/principal';
import type { SqliteValue } from '@epicenter/sqlite';
import { Ok, type Result } from 'wellcrafted/result';

/**
 * This host's owner, which is the one `@epicenter/device` names.
 *
 * An alias rather than a second declaration of the same two methods: the
 * browser's worker owns an OPFS pool and this owns files below the Epicenter
 * data root, and the whole point of the shared type is that a caller cannot
 * tell which it is holding.
 */
export type BunDevice = DeviceSqliteOwner;

/** One live connection per scoped database, and the file it is connected to. */
type OpenedDatabase = {
	handle: OwnedSqliteHandle;
	path: string;
};

/** Open, retain, and delete one owner-local handle per scoped database. */
export function createBunDevice(root: string): BunDevice {
	const opened = new Map<string, Promise<OpenedDatabase>>();

	function openDatabase(
		appId: string,
		account: AccountIdentity | null,
		name: string,
	): Promise<OpenedDatabase> {
		if (!isAppId(appId)) throw new Error('Invalid application id.');
		const key = `${appId}/${accountPath(account)}/${name}`;
		const existing = opened.get(key);
		if (existing !== undefined) return existing;
		const opening = (async () => {
			const directory = join(
				appDataDir(root, appId),
				accountPath(account),
				'sqlite',
			);
			await mkdir(directory, { recursive: true });
			const path = join(directory, `${name}.sqlite`);
			const database = new Database(path, { create: true });
			database.run('PRAGMA busy_timeout = 5000');
			return { handle: createAsyncHandle(database), path };
		})();
		// A rejected open holds no `Database`, so forgetting it is safe, and
		// keeping it would answer every later open of this name with a
		// failure that has already passed: one momentary `mkdir` refusal
		// would otherwise last as long as the host process.
		opening.catch(() => opened.delete(key));
		opened.set(key, opening);
		return opening;
	}

	return {
		open: async (appId, account, name) =>
			(await openDatabase(appId, account, name)).handle,
		/**
		 * Close this owner's connection, then unlink the file (ADR-0321).
		 *
		 * The close runs behind everything already queued on the handle, so a
		 * statement in flight finishes against a file that still exists. The
		 * three paths go together because SQLite writes three: unlinking the
		 * database and leaving its write-ahead log would let the next open of
		 * the same name read a journal describing a file that is gone.
		 *
		 * A name that was never created deletes successfully. The caller asked
		 * for it to be gone, and it is.
		 *
		 * **An application sequences its own calls.** An `open` of this name that
		 * arrives while this is running creates the file again and this unlinks
		 * it underneath, so the two are not to be issued concurrently for one
		 * name. This is the same assumption the whole handle registry makes: it
		 * holds one connection per name for an application that opens once.
		 */
		delete: async (appId, account, name) => {
			if (!isAppId(appId)) throw new Error('Invalid application id.');
			const key = `${appId}/${accountPath(account)}/${name}`;
			const existing = opened.get(key);
			opened.delete(key);
			const directory = join(
				appDataDir(root, appId),
				accountPath(account),
				'sqlite',
			);
			const path = join(directory, `${name}.sqlite`);
			if (existing !== undefined) {
				const database = await existing.catch(() => undefined);
				await database?.handle.close();
			}
			await Promise.all(
				[path, `${path}-wal`, `${path}-shm`].map((file) =>
					rm(file, { force: true }),
				),
			);
		},
	};
}

function accountPath(account: AccountIdentity | null): string {
	return account === null
		? 'local'
		: `accounts/${account.authorityId}/${account.principalId}`;
}

/** What the owner holds: the application's three verbs, plus the close it may not call. */
type OwnedSqliteHandle = AppSqliteDatabase & { close(): Promise<void> };

function createAsyncHandle(database: Database): OwnedSqliteHandle {
	let queue = Promise.resolve();
	const serialize = <T>(operation: () => T): Promise<T> => {
		const next = queue.then(operation, operation);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	return {
		run: (sql, parameters) =>
			resultOf(
				serialize(() => {
					const result = database.query(sql).run(...toBindings(parameters));
					return { changes: result.changes };
				}),
			),
		all: <TRow>(sql: string, parameters?: readonly SqliteValue[]) =>
			resultOf(
				serialize(() =>
					database
						.query<TRow, SQLQueryBindings[]>(sql)
						.all(...toBindings(parameters)),
				),
			),
		batch: (statements) =>
			resultOf(
				serialize(() =>
					database.transaction(() => {
						const changes: number[] = [];
						for (const statement of statements) {
							const result = database
								.query(statement.sql)
								.run(...toBindings(statement.parameters));
							changes.push(result.changes);
						}
						return { changes };
					})(),
				),
			),
		// Behind the queue, so a statement already accepted runs against a file
		// that is still there. Only the owner reaches this: the application's
		// handle is the three verbs above (ADR-0312, ADR-0321).
		close: () => serialize(() => database.close(false)),
	};
}

function toBindings(
	parameters: readonly SqliteValue[] | undefined,
): SQLQueryBindings[] {
	return [...(parameters ?? [])] as SQLQueryBindings[];
}

function resultOf<T>(promise: Promise<T>): Promise<Result<T, DeviceError>> {
	return promise.then(
		(data) => Ok(data),
		(cause) => DeviceError.StorageFailed({ cause }),
	);
}
