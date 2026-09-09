import { isQueryResult } from '@epicenter/device/query';
/** Native physical SQLite ownership behind the shared TypeScript lifetime. */
import { DeviceError } from '@epicenter/device';
import { createSqliteOwner, type SqliteBackend } from '@epicenter/device/owner';
import type { LibraryReplicaIdentity } from '@epicenter/principal';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { tryAsync } from 'wellcrafted/result';

export type NativeSqliteValue = string | number | null | { blob: number[] };
type NativeStatement = { sql: string; parameters: NativeSqliteValue[] };
export type NativeSqliteRequest =
	| {
			kind: 'open' | 'delete';
			appId: string;
			replica: LibraryReplicaIdentity;
			name: string;
	  }
	| { kind: 'close'; connection: string }
	| { kind: 'run' | 'all'; connection: string; statement: NativeStatement }
	| { kind: 'batch'; connection: string; statements: NativeStatement[] }
	| {
			kind: 'query';
			connection: string;
			statement: NativeStatement;
			tables: readonly string[];
	  };

function statement(
	sql: string,
	parameters: readonly SqliteValue[] = [],
): NativeStatement {
	return {
		sql,
		parameters: parameters.map((value) => {
			if (value instanceof Uint8Array) return { blob: [...value] };
			if (typeof value === 'number' && !Number.isFinite(value))
				throw new Error('SQLite parameters must be finite.');
			return value;
		}),
	};
}
function record(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new Error('Invalid native SQLite result.');
	return value as Record<string, unknown>;
}
function changes(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		throw new Error('Invalid native SQLite changes.');
	return value;
}
function rows(value: unknown): SqliteRow[] {
	if (!Array.isArray(value)) throw new Error('Invalid native SQLite rows.');
	return value.map((row) =>
		Object.fromEntries(
			Object.entries(record(row)).map(([key, value]) => {
				if (
					value === null ||
					typeof value === 'string' ||
					(typeof value === 'number' && Number.isFinite(value))
				)
					return [key, value];
				const blob = record(value);
				if (
					Object.keys(blob).length !== 1 ||
					!Array.isArray(blob.blob) ||
					!blob.blob.every(
						(byte) =>
							typeof byte === 'number' &&
							Number.isInteger(byte) &&
							byte >= 0 &&
							byte <= 255,
					)
				)
					throw new Error('Invalid native SQLite blob.');
				return [key, new Uint8Array(blob.blob)];
			}),
		),
	);
}
export function createNativeDevice(native: {
	sqlite(request: NativeSqliteRequest, signal?: AbortSignal): Promise<unknown>;
}) {
	const backend: SqliteBackend = {
		async open(appId, replica, name) {
			const opened = record(
				await native.sqlite({ kind: 'open', appId, replica, name }),
			);
			if (typeof opened.connection !== 'string' || opened.connection === '')
				throw new Error('Invalid native SQLite connection.');
			const connection = opened.connection;
			return {
				query: (sql, options) =>
					tryAsync({
						try: async () => {
							const value = await native.sqlite(
								{
									kind: 'query',
									connection,
									statement: statement(sql, options.parameters),
									tables: options.tables,
								},
								options.signal,
							);
							if (!isQueryResult(value))
								throw new Error('Invalid native SQLite query result.');
							return value;
						},
						catch: (cause) => DeviceError.StorageFailed({ cause }),
					}),
				run: (sql, parameters) =>
					tryAsync({
						try: async () => ({
							changes: changes(
								record(
									await native.sqlite({
										kind: 'run',
										connection,
										statement: statement(sql, parameters),
									}),
								).changes,
							),
						}),
						catch: (cause) => DeviceError.StorageFailed({ cause }),
					}),
				all: <TRow extends SqliteRow>(
					sql: string,
					parameters?: readonly SqliteValue[],
				) =>
					tryAsync({
						try: async () =>
							rows(
								await native.sqlite({
									kind: 'all',
									connection,
									statement: statement(sql, parameters),
								}),
							) as TRow[],
						catch: (cause) => DeviceError.StorageFailed({ cause }),
					}),
				batch: (statements) =>
					tryAsync({
						try: async () => {
							const response = record(
								await native.sqlite({
									kind: 'batch',
									connection,
									statements: statements.map((item) =>
										statement(item.sql, item.parameters),
									),
								}),
							);
							if (!Array.isArray(response.changes))
								throw new Error('Invalid native SQLite batch.');
							return { changes: response.changes.map(changes) };
						},
						catch: (cause) => DeviceError.StorageFailed({ cause }),
					}),
				async close() {
					await native.sqlite({ kind: 'close', connection });
				},
			};
		},
		async delete(appId, replica, name) {
			await native.sqlite({ kind: 'delete', appId, replica, name });
		},
	};
	return createSqliteOwner(backend);
}
