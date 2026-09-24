import { type AccountIdentity, deviceOwnerPath } from '@epicenter/principal';
/** SQLite lifetime ownership shared by the native host and browser worker. */
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { Ok, type Result } from 'wellcrafted/result';
import { type AppSqliteDatabase, appIdOrThrow, DeviceError } from './index.js';
import {
	type DeviceRequest,
	type DeviceResponse,
	isDatabaseName,
} from './protocol.js';
import type { QueryOptions } from './query.js';

export type SqliteLifetime = {
	open(name: string): Promise<AppSqliteDatabase>;
	delete(name: string): Promise<void>;
	close(): Promise<void>;
};
export type DeviceSqliteOwner = {
	acquire(appId: string, account?: AccountIdentity): Promise<SqliteLifetime>;
};
export type SqliteBackend = {
	open(
		appId: string,
		name: string,
		account?: AccountIdentity,
	): Promise<AppSqliteDatabase & { close(): Promise<void> }>;
	delete(appId: string, name: string, account?: AccountIdentity): Promise<void>;
	/** Release owner-wide physical resources after every connection has closed. */
	release?(appId: string, account?: AccountIdentity): Promise<void>;
};
function validateName(name: string) {
	if (!isDatabaseName(name)) throw new Error('Invalid SQLite database name.');
}

/** Reserve one SQL lifetime per application and account until physical close succeeds. */
export function createSqliteOwner(backend: SqliteBackend): DeviceSqliteOwner {
	const claimed = new Set<string>();
	return {
		async acquire(appId, account) {
			const key = JSON.stringify([
				appIdOrThrow(appId),
				deviceOwnerPath(account),
			]);
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
						const database = await backend.open(appId, name, account);

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
							query: (sql, options) =>
								statement(() =>
									options.signal?.aborted
										? Promise.resolve(
												DeviceError.StorageFailed({
													cause: new Error('Query cancelled.'),
												}),
											)
										: database.query(sql, options),
								),

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
						await backend.delete(appId, name, account);
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
						await backend.release?.(appId, account);
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
	const queries = new Map<
		string,
		{ lifetimeId: string; connectionId: string; controller: AbortController }
	>();
	async function dispatch(request: AppSqliteRequest): Promise<DeviceResponse> {
		const key = JSON.stringify([
			appIdOrThrow(request.appId),
			deviceOwnerPath(request.account),
		]);
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
				for (const query of queries.values())
					if (query.lifetimeId === request.lifetimeId) query.controller.abort();
				lifetimes.delete(request.lifetimeId);
				try {
					await owned.lifetime.close();
				} catch (cause) {
					cleanupFailures.push(cause);
					throw cause;
				}
				return { kind: request.kind };
			case 'sqlite-cancel': {
				const query = queries.get(request.queryId);
				if (
					query?.lifetimeId === request.lifetimeId &&
					query.connectionId === request.connectionId
				)
					query.controller.abort();
				return { kind: request.kind };
			}
			case 'sqlite-query': {
				const database = owned.connections.get(request.connectionId)?.database;
				if (!database) throw new Error('Unknown SQLite connection.');
				if (queries.has(request.queryId))
					throw new Error('Duplicate query ID.');
				const controller = new AbortController();
				queries.set(request.queryId, {
					lifetimeId: request.lifetimeId,
					connectionId: request.connectionId,
					controller,
				});
				try {
					const result = await database.query(request.statement.sql, {
						parameters: request.statement.parameters,
						tables: request.tables,
						signal: controller.signal,
					});
					if (result.error) throw result.error;
					return { kind: request.kind, result: result.data };
				} finally {
					queries.delete(request.queryId);
				}
			}
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
				for (const query of queries.values()) query.controller.abort();
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
			appIdOrThrow(appId);
			const { lifetimeId } = await send(
				{ kind: 'sqlite-acquire', appId, account },
				'sqlite-acquire',
			);
			const session = { appId, account, lifetimeId };
			let closed = false;
			let closing: Promise<void> | undefined;
			const pending = new Set<Promise<unknown>>();
			const dispatch = request;
			function admitted(message: AppSqliteRequest) {
				if (closed)
					return Promise.resolve(
						DeviceError.StorageFailed({
							cause: new Error('SQLite lifetime is closed.'),
						}),
					);
				const completion =
					Promise.withResolvers<Result<DeviceResponse, DeviceError>>();
				pending.add(completion.promise);
				void completion.promise.then(
					() => pending.delete(completion.promise),
					() => pending.delete(completion.promise),
				);
				try {
					completion.resolve(dispatch(message));
				} catch (cause) {
					completion.reject(cause);
				}
				return completion.promise;
			}
			async function sendOwned<TKind extends DeviceResponse['kind']>(
				message: AppSqliteRequest,
				kind: TKind,
			) {
				const result = await unwrap(admitted(message), kind, (value) => value);
				if (result.error) throw result.error;
				return result.data;
			}

			return {
				async open(name) {
					const { connectionId } = await sendOwned(
						{ kind: 'sqlite-open', ...session, name },
						'sqlite-open',
					);
					return {
						async query(sql: string, options: QueryOptions) {
							if (options.signal?.aborted)
								return DeviceError.StorageFailed({
									cause: new Error('Query cancelled.'),
								});
							const queryId = crypto.randomUUID();
							const response = admitted({
								kind: 'sqlite-query',
								...session,
								connectionId,
								queryId,
								statement: { sql, parameters: options.parameters },
								tables: options.tables,
							});
							const cancel = () => {
								void admitted({
									kind: 'sqlite-cancel',
									...session,
									connectionId,
									queryId,
								}).catch(() => undefined);
							};
							options.signal?.addEventListener('abort', cancel, { once: true });
							if (options.signal?.aborted) cancel();
							try {
								return await unwrap(
									response,
									'sqlite-query',
									(value) => value.result,
								);
							} finally {
								options.signal?.removeEventListener('abort', cancel);
							}
						},
						run: (sql, parameters) =>
							unwrap(
								admitted({
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
								admitted({
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
								admitted({
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
					await sendOwned(
						{ kind: 'sqlite-delete', ...session, name },
						'sqlite-delete',
					);
				},
				close() {
					if (closing) return closing;
					const completion = Promise.withResolvers<void>();
					closing = completion.promise;
					closed = true;
					// Bypass admission so the host cancels active queries before draining.
					const release = send(
						{ kind: 'sqlite-close', ...session },
						'sqlite-close',
					);
					void (async () => {
						const results = await Promise.allSettled([...pending, release]);
						const released = results.at(-1)!;
						if (released.status === 'rejected') throw released.reason;
					})().then(completion.resolve, completion.reject);
					return closing;
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
