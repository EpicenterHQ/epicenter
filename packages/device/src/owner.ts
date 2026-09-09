/** SQLite lifetime ownership shared by the native host and browser worker. */
import type { AccountIdentity } from '@epicenter/principal';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import { claimLibrary } from './library-claim.js';
import { appIdOrThrow, type AppSqliteDatabase, DeviceError } from './index.js';
import {
	isDatabaseName,
	isSqliteAccount,
	type DeviceRequest,
	type DeviceResponse,
} from './protocol.js';

export type SqliteLifetime = {
	open(name: string): Promise<AppSqliteDatabase>;
	delete(name: string): Promise<void>;
	close(): Promise<void>;
};
export type DeviceSqliteOwner = {
	acquire(
		appId: string,
		account: AccountIdentity | null,
	): Promise<SqliteLifetime>;
};
export type SqliteBackend = {
	open(
		appId: string,
		account: AccountIdentity | null,
		name: string,
	): Promise<AppSqliteDatabase & { close(): Promise<void> }>;
	delete(
		appId: string,
		account: AccountIdentity | null,
		name: string,
	): Promise<void>;
};
function capture(appId: string, account: AccountIdentity | null) {
	appIdOrThrow(appId);
	if (!isSqliteAccount(account)) throw new Error('Invalid SQLite account.');
	return account === null
		? null
		: Object.freeze({
				authorityId: account.authorityId,
				principalId: account.principalId,
			});
}
function address(appId: string, account: AccountIdentity | null) {
	return JSON.stringify([
		appId,
		account?.authorityId ?? null,
		account?.principalId ?? null,
	]);
}
function validateName(name: string) {
	if (!isDatabaseName(name)) throw new Error('Invalid SQLite database name.');
}

/** Reserve one SQL lifetime per app/account until every physical close succeeds. */
export function createSqliteOwner(backend: SqliteBackend): DeviceSqliteOwner {
	const claimed = new Set<string>();
	return {
		async acquire(appId, account) {
			const identity = capture(appId, account);
			const key = address(appId, identity);
			if (claimed.has(key))
				throw new Error('SQLite lifetime is already acquired.');
			claimed.add(key);
			let closed = false;
			let closing: Promise<void> | undefined;
			let tail: Promise<unknown> = Promise.resolve();
			const databases = new Map<
				string,
				{
					database: Awaited<ReturnType<SqliteBackend['open']>>;
					handle: AppSqliteDatabase;
					active: boolean;
				}
			>();
			function enqueue<T>(operation: () => Promise<T>): Promise<T> {
				if (closed)
					return Promise.reject(new Error('SQLite lifetime is closed.'));
				const result = tail.then(operation);
				tail = result.catch(() => undefined);
				return result;
			}
			return {
				open(name) {
					return enqueue(async () => {
						validateName(name);
						const existing = databases.get(name);
						if (existing) {
							if (!existing.active)
								throw new Error('SQLite connection cleanup failed.');
							return existing.handle;
						}
						const database = await backend.open(appId, identity, name);

						function statement<T>(
							run: () => Promise<Result<T, DeviceError>>,
						): Promise<Result<T, DeviceError>> {
							return enqueue(async () => {
								if (!entry.active)
									return DeviceError.StorageFailed({
										cause: new Error('SQLite connection is closed.'),
									});
								return run();
							}).catch((cause: unknown) =>
								DeviceError.StorageFailed({ cause }),
							);
						}
						const handle: AppSqliteDatabase = {
							run: (sql, parameters) =>
								statement(() => database.run(sql, parameters)),
							all: <TRow extends SqliteRow>(
								sql: string,
								parameters?: readonly SqliteValue[],
							) => statement(() => database.all<TRow>(sql, parameters)),
							batch: (statements) =>
								statement(() => database.batch(statements)),
						};
						const entry = { database, handle, active: true };
						databases.set(name, entry);
						return handle;
					});
				},
				delete(name) {
					return enqueue(async () => {
						validateName(name);
						const entry = databases.get(name);
						if (entry) {
							entry.active = false;
							await entry.database.close();
							databases.delete(name);
						}
						await backend.delete(appId, identity, name);
					});
				},
				close() {
					if (closing) return closing;
					closed = true;
					closing = tail.then(async () => {
						const results = await Promise.allSettled(
							[...databases.values()].map(async (entry) => {
								entry.active = false;
								await entry.database.close();
							}),
						);
						const failures = results
							.filter((result) => result.status === 'rejected')
							.map((result) => result.reason);
						if (failures.length)
							throw new AggregateError(
								failures,
								'SQLite lifetime cleanup failed.',
							);
						databases.clear();
						claimed.delete(key);
					});
					return closing;
				},
			};
		},
	};
}

export type AppSqliteRequest = Extract<
	DeviceRequest,
	{ kind: `sqlite-${string}` }
>;
export type AppSqliteTransport = (
	message: AppSqliteRequest,
) => Promise<Result<DeviceResponse, DeviceError>>;
export type ScopedSqlite = {
	open(name: string): Promise<Result<AppSqliteDatabase, DeviceError>>;
	delete(name: string): Promise<Result<void, DeviceError>>;
};

/** Capture identity now; acquire lazily, including when a SQL-only document starts. */
export function createAppSqlite(
	owner: DeviceSqliteOwner,
	appId: string,
	account: AccountIdentity | null,
) {
	const identity = capture(appId, account);

	let pending:
		| Promise<
				Result<{ lifetime: SqliteLifetime; release(): void }, DeviceError>
		  >
		| undefined;
	let closed = false;
	let closing: Promise<void> | undefined;
	function acquire() {
		if (closed)
			return Promise.resolve(
				DeviceError.StorageFailed({
					cause: new Error('SQLite lifetime is closed.'),
				}),
			);
		return (pending ??= (async () => {
			const claim = await claimLibrary(appId, identity);
			if (claim.error) return claim;
			try {
				return Ok({
					lifetime: await owner.acquire(appId, identity),
					release: claim.data.release,
				});
			} catch (cause) {
				claim.data.release();
				return DeviceError.StorageFailed({ cause });
			}
		})());
	}
	return {
		async acquire(): Promise<Result<void, DeviceError>> {
			const result = await acquire();
			return result.error ? result : Ok(undefined);
		},
		async open(name: string): Promise<Result<AppSqliteDatabase, DeviceError>> {
			if (!isDatabaseName(name))
				return DeviceError.InvalidDatabaseName({ databaseName: name });
			const result = await acquire();
			if (result.error) return result;
			return tryAsync({
				try: () => result.data.lifetime.open(name),
				catch: (cause) => DeviceError.StorageFailed({ cause }),
			});
		},
		async delete(name: string): Promise<Result<void, DeviceError>> {
			if (!isDatabaseName(name))
				return DeviceError.InvalidDatabaseName({ databaseName: name });
			const result = await acquire();
			if (result.error) return result;
			return tryAsync({
				try: () => result.data.lifetime.delete(name),
				catch: (cause) => DeviceError.StorageFailed({ cause }),
			});
		},
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			return (closing = pending
				? pending.then(async (result) => {
						if (result.error) return;
						await result.data.lifetime.close();
						result.data.release();
					})
				: Promise.resolve());
		},
	};
}

/** Each runtime keeps its own nonreusable lifetime and connection registry. */
export function createDeviceDispatcher(owner: DeviceSqliteOwner) {
	const lifetimes = new Map<
		string,
		{
			key: string;
			lifetime: SqliteLifetime;
			connections: Map<string, { name: string; database: AppSqliteDatabase }>;
		}
	>();
	let closed = false;
	let closing: Promise<void> | undefined;
	const pending = new Set<Promise<DeviceResponse>>();
	const cleanupFailures: unknown[] = [];
	async function dispatch(request: AppSqliteRequest): Promise<DeviceResponse> {
		capture(request.appId, request.account);
		const key = address(request.appId, request.account);
		if (request.kind === 'sqlite-acquire') {
			const lifetime = await owner.acquire(request.appId, request.account);
			const lifetimeId = crypto.randomUUID();
			lifetimes.set(lifetimeId, { key, lifetime, connections: new Map() });
			return { kind: request.kind, lifetimeId };
		}
		const owned = lifetimes.get(request.lifetimeId);
		if (!owned || owned.key !== key)
			throw new Error('Unknown SQLite lifetime.');
		switch (request.kind) {
			case 'sqlite-open': {
				validateName(request.name);
				const database = await owned.lifetime.open(request.name);
				for (const [connectionId, connection] of owned.connections) {
					if (connection.database === database)
						return { kind: request.kind, connectionId };
				}
				const connectionId = crypto.randomUUID();
				owned.connections.set(connectionId, { name: request.name, database });
				return { kind: request.kind, connectionId };
			}
			case 'sqlite-delete': {
				validateName(request.name);
				const retired = [...owned.connections]
					.filter(([, connection]) => connection.name === request.name)
					.map(([id]) => id);
				await owned.lifetime.delete(request.name);
				for (const id of retired) owned.connections.delete(id);
				return { kind: request.kind };
			}
			case 'sqlite-close':
				// Revoke before awaiting physical cleanup, including if cleanup fails.
				lifetimes.delete(request.lifetimeId);
				try {
					await owned.lifetime.close();
				} catch (cause) {
					cleanupFailures.push(cause);
					throw cause;
				}
				return { kind: request.kind };
			case 'sqlite-run':
			case 'sqlite-all':
			case 'sqlite-batch': {
				const database = owned.connections.get(request.connectionId)?.database;
				if (!database) throw new Error('Unknown SQLite connection.');
				if (request.kind === 'sqlite-run') {
					const result = await database.run(
						request.statement.sql,
						request.statement.parameters,
					);
					if (result.error) throw result.error;
					return { kind: request.kind, changes: result.data.changes };
				}
				if (request.kind === 'sqlite-all') {
					const result = await database.all(
						request.statement.sql,
						request.statement.parameters,
					);
					if (result.error) throw result.error;
					return { kind: request.kind, rows: result.data };
				}
				const result = await database.batch(request.statements);
				if (result.error) throw result.error;
				return { kind: request.kind, changes: result.data.changes };
			}
		}
	}
	return {
		request(request: AppSqliteRequest): Promise<DeviceResponse> {
			if (closed)
				return Promise.reject(new Error('SQLite dispatcher is closed.'));
			const result = dispatch(request);
			pending.add(result);
			void result.then(
				() => pending.delete(result),
				() => pending.delete(result),
			);
			return result;
		},
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			closing = (async () => {
				await Promise.allSettled([...pending]);
				const results = await Promise.allSettled(
					[...lifetimes.values()].map(({ lifetime }) => lifetime.close()),
				);
				lifetimes.clear();
				const failures = [
					...cleanupFailures,
					...results
						.filter((result) => result.status === 'rejected')
						.map((result) => result.reason),
				];
				if (failures.length)
					throw new AggregateError(
						failures,
						'SQLite dispatcher cleanup failed.',
					);
			})();
			return closing;
		},
	};
}

/** Transport owners acquire real remote lifetimes before returning a database. */
export function createTransportSqliteOwner(
	request: AppSqliteTransport,
): DeviceSqliteOwner {
	async function send<TKind extends DeviceResponse['kind']>(
		message: AppSqliteRequest,
		kind: TKind,
	) {
		const result = await unwrap(request(message), kind, (response) => response);
		if (result.error) throw result.error;
		return result.data;
	}
	return {
		async acquire(appId, account) {
			const identity = capture(appId, account);
			const { lifetimeId } = await send(
				{ kind: 'sqlite-acquire', appId, account: identity },
				'sqlite-acquire',
			);
			const session = { appId, account: identity, lifetimeId };
			return {
				async open(name) {
					const { connectionId } = await send(
						{ kind: 'sqlite-open', ...session, name },
						'sqlite-open',
					);
					return {
						run: (sql, parameters) =>
							unwrap(
								request({
									kind: 'sqlite-run',
									...session,
									connectionId,
									statement: { sql, parameters },
								}),
								'sqlite-run',
								(response) => ({ changes: response.changes }),
							),
						all: <TRow extends SqliteRow>(
							sql: string,
							parameters?: readonly SqliteValue[],
						) =>
							unwrap(
								request({
									kind: 'sqlite-all',
									...session,
									connectionId,
									statement: { sql, parameters },
								}),
								'sqlite-all',
								(response) => response.rows as TRow[],
							),
						batch: (statements) =>
							unwrap(
								request({
									kind: 'sqlite-batch',
									...session,
									connectionId,
									statements,
								}),
								'sqlite-batch',
								(response) => ({ changes: [...response.changes] }),
							),
					};
				},
				async delete(name) {
					await send(
						{ kind: 'sqlite-delete', ...session, name },
						'sqlite-delete',
					);
				},
				async close() {
					await send({ kind: 'sqlite-close', ...session }, 'sqlite-close');
				},
			};
		},
	};
}

export function unwrap<TKind extends DeviceResponse['kind'], TValue>(
	pending: Promise<Result<DeviceResponse, DeviceError>>,
	kind: TKind,
	read: (response: Extract<DeviceResponse, { kind: TKind }>) => TValue,
): Promise<Result<TValue, DeviceError>> {
	return pending.then((outcome) => {
		if (outcome.error !== null) return outcome;
		if (outcome.data.kind !== kind) return DeviceError.InvalidResponse();
		return Ok(read(outcome.data as Extract<DeviceResponse, { kind: TKind }>));
	});
}
