/**
 * What owns application SQLite files, and the one handle every caller holds
 * over one.
 *
 * Three transports reach an owner and there are only ever two owners. The
 * desktop page sends `DeviceRequest` over same-origin HTTP to a Bun
 * process that owns files below the Epicenter data root; the browser page
 * sends the same request over `postMessage` to a worker that owns an OPFS
 * pool; the Bun host answers itself. What differs between those is a socket
 * and an envelope, so that is all each transport writes: the handle, the
 * dispatch, and the meaning of every message are here, once.
 *
 * This is the shape the codebase already had in three places without naming
 * it. `BunDevice` and the browser leaf's SQLite owner were the same two
 * methods declared twice, and `apps/epicenter`'s route carried the only
 * request-to-owner dispatcher, where no other transport could reach it.
 */

import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type AppSqliteDatabase,
	DeviceError,
} from './index.js';
import type {
	DeviceRequest,
	DeviceResponse,
	StorageScope,
} from './protocol.js';
import { isDatabaseName } from './protocol.js';

/**
 * Whoever actually holds the files, for every application on this machine.
 *
 * Two methods, because that is the whole of what an owner does that a caller
 * cannot: hold a connection open across statements, and unlink a file after
 * closing the connection to it, which the application cannot do because it
 * never had the handle (ADR-0321).
 *
 * `open` never means "create a session". Both owners resolve a name to a live
 * connection and cache it, so a caller that opens the same name twice gets one
 * connection and a caller that opens after a delete gets a new empty file.
 * That is why nothing on this type closes: closing is a step inside `delete`.
 */
export type DeviceSqliteOwner = {
	open(appId: string, scope: StorageScope, name: string): Promise<AppSqliteDatabase>;
	delete(appId: string, scope: StorageScope, name: string): Promise<void>;
};

/** The requests an owner answers. Secrets are a different owner entirely. */
export type AppSqliteRequest = Extract<
	DeviceRequest,
	{ kind: `sqlite-${string}` }
>;

/**
 * Answer one request from an owner.
 *
 * The dispatcher, written where every transport can reach it rather than
 * inside the one that happened to need it first. A transport's whole job
 * becomes carrying this call somewhere and carrying the answer back.
 *
 * It throws rather than returning a `Result`, because each transport already
 * has a failure carriage of its own and they do not agree: HTTP has a status,
 * `postMessage` has a message, and the Bun host has a 500. Handing all three a
 * `Result` would mean two of them unwrapping it to build their own.
 */
export async function answerDevice(
	owner: DeviceSqliteOwner,
	request: AppSqliteRequest,
): Promise<DeviceResponse> {
	if (request.kind === 'sqlite-delete') {
		await owner.delete(request.appId, request.scope, request.name);
		return { kind: request.kind };
	}
	const database = await owner.open(request.appId, request.scope, request.name);
	switch (request.kind) {
		case 'sqlite-run': {
			const result = await database.run(
				request.statement.sql,
				request.statement.parameters,
			);
			if (result.error !== null) throw result.error;
			return { kind: request.kind, changes: result.data.changes };
		}
		case 'sqlite-all': {
			const result = await database.all(
				request.statement.sql,
				request.statement.parameters,
			);
			if (result.error !== null) throw result.error;
			return { kind: request.kind, rows: result.data };
		}
		case 'sqlite-batch': {
			const result = await database.batch(request.statements);
			if (result.error !== null) throw result.error;
			return { kind: request.kind, changes: result.data.changes };
		}
	}
}

/** How a page reaches its owner, whatever is carrying the message. */
export type AppSqliteTransport = (
	message: AppSqliteRequest,
) => Promise<Result<DeviceResponse, DeviceError>>;

/** Bind one owner to an app while leaving local/account selection to its opener. */
export type ScopedSqlite = {
	open(name: string): Promise<
		Result<AppSqliteDatabase, DeviceError>
	>;
	delete(name: string): Promise<Result<void, DeviceError>>;
};

export function createScopedSqlite(
	owner: DeviceSqliteOwner,
	appId: string,
	scope: StorageScope,
	assertUsable: () => void = () => {},
	trackOperation: <T>(operation: () => Promise<T>) => Promise<T> = (operation) =>
		operation(),
): ScopedSqlite {
	return {
		open: async (name) => {
			assertUsable();
			if (!isDatabaseName(name))
				return DeviceError.InvalidDatabaseName({ databaseName: name });
			try {
				const database = await trackOperation(() =>
					owner.open(appId, scope, name),
				);
				return Ok({
					run: (...args) => {
						assertUsable();
						return trackOperation(() => database.run(...args));
					},
					all: (...args) => {
						assertUsable();
						return trackOperation(() => database.all(...args));
					},
					batch: (...args) => {
						assertUsable();
						return trackOperation(() => database.batch(...args));
					},
				});
			} catch (cause) {
				return DeviceError.StorageFailed({ cause });
			}
		},
		delete: async (name) => {
			assertUsable();
			if (!isDatabaseName(name))
				return DeviceError.InvalidDatabaseName({ databaseName: name });
			try {
				await trackOperation(() => owner.delete(appId, scope, name));
				return Ok(undefined);
			} catch (cause) {
				return DeviceError.StorageFailed({ cause });
			}
		},
	};
}

/**
 * One database's handle, over a transport.
 *
 * It holds a name and never a connection, so it is the same object whether the
 * owner is a Bun process or a worker in this tab, and it survives its file
 * being deleted: a statement through a handle kept past a `delete` reaches the
 * owner, which opens the name again and finds it empty. That is the semantics
 * ADR-0321 allows and the desktop leaf already had; the browser leaf used to
 * fail forever instead, which was the same handle meaning two things.
 */
export function createOwnedSqlite(
	request: AppSqliteTransport,
	appId: string,
	scope: StorageScope,
	name: string,
): AppSqliteDatabase {
	return {
		run: (sql, parameters) =>
			unwrap(
				request({
					kind: 'sqlite-run',
					appId,
					scope,
					name,
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
					appId,
					scope,
					name,
					statement: { sql, parameters },
				}),
				'sqlite-all',
				(response) => response.rows as TRow[],
			),
		batch: (statements) =>
			unwrap(
				request({ kind: 'sqlite-batch', appId, scope, name, statements }),
				'sqlite-batch',
				(response) => ({ changes: [...response.changes] }),
			),
	};
}

/** Unwrap one response, refusing an owner that answered about something else. */
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
