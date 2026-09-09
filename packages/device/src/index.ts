/**
 * Runtime-owned SQLite files and application secrets.
 * SQLite lifetimes capture an app and account identity; standalone devices use
 * the local identity. Closing a lifetime releases connections and preserves
 * files and secrets. Platform imports select the browser worker or native host.
 */

import { isAppId } from '@epicenter/constants/app-id';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import { LibraryClaimError } from './library-claim.js';
import type { ScopedSqlite } from './owner.js';
import { isSecretLabel, type SecretLabel } from './protocol.js';

export const DeviceError = {
	...defineErrors({
		InvalidAppId: ({ appId }: { appId: string }) => ({
			message: `The application id '${appId}' is not valid.`,
			appId,
		}),
		InvalidDatabaseName: ({ databaseName }: { databaseName: string }) => ({
			message: `The SQLite database name '${databaseName}' is not valid.`,
			databaseName,
		}),
		StorageFailed: ({ cause }: { cause: unknown }) => ({
			message: 'The device storage owner failed.',
			cause,
		}),
		ProtocolFailed: ({ status }: { status: number }) => ({
			message: `The device storage owner rejected the request (${status}).`,
			status,
		}),
		InvalidResponse: () => ({
			message: 'The device storage owner returned an invalid response.',
		}),
	}),
	...LibraryClaimError,
};
export type DeviceError = InferErrors<typeof DeviceError>;

export const SecretError = defineErrors({
	InvalidSecretLabel: ({ label }: { label: string }) => ({
		message: `The secret label '${label}' is not valid.`,
		label,
	}),
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The secret owner failed.',
		cause,
	}),
});
export type SecretError = InferErrors<typeof SecretError>;

/**
 * Secret labels are re-exported here because they are part of the device
 * credential capability. SQLite names belong to the scoped application
 * capability and are validated when that capability opens them.
 */
export {
	isSecretLabel,
	type SecretLabel,
} from './protocol.js';

/**
 * Narrow one application id at the composition boundary.
 *
 * Both constructors call it, so a bad id is refused where it is supplied
 * rather than accepted here and refused later by the host, which would report
 * it as a rejected request against an application that never existed.
 */
export function appIdOrThrow(value: string): string {
	if (!isAppId(value)) {
		throw new Error(DeviceError.InvalidAppId({ appId: value }).error.message);
	}
	return value;
}

/** Mint one secret label at the credential composition boundary. */
export function secretLabel(value: string): SecretLabel {
	if (!isSecretLabel(value)) {
		throw new Error(
			SecretError.InvalidSecretLabel({ label: value }).error.message,
		);
	}
	return value;
}

/**
 * Statements on one acquired connection. Deleting its file or closing its
 * lifetime permanently retires this handle. Batch executes one transaction.
 */
export type AppSqliteDatabase = {
	run(
		sql: string,
		parameters?: readonly SqliteValue[],
	): Promise<Result<{ changes: number }, DeviceError>>;
	all<TRow extends SqliteRow = SqliteRow>(
		sql: string,
		parameters?: readonly SqliteValue[],
	): Promise<Result<TRow[], DeviceError>>;
	batch(
		statements: readonly {
			sql: string;
			parameters?: readonly SqliteValue[];
		}[],
	): Promise<Result<{ changes: number[] }, DeviceError>>;
};

/**
 * Three verbs and no enumeration (ADR-0310).
 *
 * There is no way to ask whether this runtime keeps a secret across a session,
 * and that absence is the design: a browser build answers `null` from `get`
 * after a reload, which is the same answer a new desktop device gives, and the
 * application already has to handle it. A `durable` flag would be a platform
 * test wearing a capability's clothes.
 */
export type SecretStore = {
	put(label: SecretLabel, value: string): Promise<Result<void, SecretError>>;
	get(label: SecretLabel): Promise<Result<string | null, SecretError>>;
	delete(label: SecretLabel): Promise<Result<void, SecretError>>;
};

/**
 * What one application owns on this device: named SQLite files, and secrets.
 *
 * Both runtime constructors answer this, so an application annotates against
 * it once and its two platform leaves cannot drift. The application id is an
 * input to the constructor rather than a member here: it scopes every file
 * name and every keychain entry underneath, and nothing reading this object
 * needs to be told which application it belongs to.
 *
 * There is no `list` on either half, for the same reason: the application's own
 * rows are the only thing that knows a name exists. A name that was never
 * created deletes successfully, because the caller asked for it to be gone and
 * it is.
 */
export type Device = {
	/** Drain and close SQLite connections, preserving files and secrets. */
	close(): Promise<void>;
	readonly sqlite: ScopedSqlite;
	readonly secrets: SecretStore;
};

export { secretScopeKey } from './secrets.js';
