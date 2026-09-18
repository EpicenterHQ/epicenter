/** Test-only SQLite backend for Bun server and lifecycle integration tests. */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appDataDir } from '@epicenter/constants/app-data';
import { type AppSqliteDatabase, DeviceError } from '@epicenter/device';
import {
	createSqliteOwner,
	type DeviceSqliteOwner,
} from '@epicenter/device/owner';
import type { SqliteValue } from '@epicenter/sqlite';
import { Ok, type Result } from 'wellcrafted/result';

/** Bun fixture for the shared SQLite lifetime owner. */
export type BunDevice = DeviceSqliteOwner;

/**
 * One process-local owner for the host's SQLite files.
 * Compose this once per data root. Separate owners or processes sharing a root
 * are outside this lifetime's exclusion boundary.
 */
export function createBunDevice(root: string): BunDevice {
	return createSqliteOwner({
		async open(appId, name) {
			const directory = join(appDataDir(root, appId), 'local', 'sqlite');
			await mkdir(directory, { recursive: true });
			const database = new Database(join(directory, `${name}.sqlite`), {
				create: true,
			});
			try {
				database.run('PRAGMA busy_timeout = 5000');
				return createAsyncHandle(database);
			} catch (cause) {
				database.close(false);
				throw cause;
			}
		},
		async delete(appId, name) {
			const path = join(appDataDir(root, appId), 'local', 'sqlite', `${name}.sqlite`);
			await Promise.all(
				[path, `${path}-wal`, `${path}-shm`, `${path}-journal`].map((file) =>
					rm(file, { force: true }),
				),
			);
		},
	});
}

/** What the owner holds: the application's three verbs, plus the close it may not call. */
type OwnedSqliteHandle = AppSqliteDatabase & { close(): Promise<void> };

function createAsyncHandle(database: Database): OwnedSqliteHandle {
	return {
		query: async () =>
			DeviceError.StorageFailed({
				cause: new Error(
					'Restricted queries require the native backend; this Bun fixture only exercises trusted storage.',
				),
			}),
		run: (sql, parameters) =>
			resultOf(() => {
				const result = database.query(sql).run(...toBindings(parameters));
				return { changes: result.changes };
			}),
		all: <TRow>(sql: string, parameters?: readonly SqliteValue[]) =>
			resultOf(() =>
				database
					.query<TRow, SQLQueryBindings[]>(sql)
					.all(...toBindings(parameters)),
			),
		batch: (statements) =>
			resultOf(() =>
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
		// The shared lifetime drains accepted statements before physical close.
		close: async () => database.close(false),
	};
}

function toBindings(
	parameters: readonly SqliteValue[] | undefined,
): SQLQueryBindings[] {
	return [...(parameters ?? [])] as SQLQueryBindings[];
}

function resultOf<T>(operation: () => T): Promise<Result<T, DeviceError>> {
	return Promise.resolve()
		.then(operation)
		.then(
			(data) => Ok(data),
			(cause) => DeviceError.StorageFailed({ cause }),
		);
}
