import { isQueryResult, type QueryResult } from './query.js';
/**
 * Messages exchanged by an application handle and the trusted desktop owner.
 *
 * Two concerns cross this seam and only two: running statements against an
 * application-owned SQLite file or deleting one, and holding one labeled
 * secret. Every message names the application, because the owner scopes
 * everything it does by that identity rather than by the socket it arrived on.
 *
 * Opening data was never one of them. The store is client-owned in every
 * runtime (ADR-0226) and a deployed app is a trusted app (ADR-0334), so it
 * never crossed this seam; it is not on the binding either any more
 * (ADR-0339). A definition is a TypeScript module a host imports from its own
 * release (ADR-0313); there is no JSON spelling of one, and this protocol has
 * no message that would carry it.
 */

import type {
	AccountIdentity,
	LibraryReplicaIdentity,
} from '@epicenter/principal';
import type { SqliteValue } from '@epicenter/sqlite';
import type { Brand } from 'wellcrafted/brand';

export const DEVICE_PATH = '/api/device';

/**
 * The names this protocol admits, owned here because both ends read them.
 *
 * They lived in two places until they were moved: the client validated before
 * sending and the host validated on arrival, with the same two regular
 * expressions written out twice. That is how a client starts refusing what a
 * server accepts, or worse, the other way round.
 *
 * The application id reuses `isAppId`, which is the grammar that already names
 * a directory below the one Epicenter data root, so a name this protocol admits
 * and a name that can be a directory are one question with one answer. It is
 * imported from `@epicenter/constants/app-id` rather than `/app-data`, because
 * that module resolves an OS path and would drag `node:os` into every page that
 * bundles this one.
 */

/**
 * One SQLite file name this platform admits, checked wherever one is minted.
 *
 * Branded for the wire and owner boundary. The application-facing scoped
 * capability accepts plain strings and performs this check exactly when a
 * database is opened or deleted; the brand stays internal to the protocol.
 *
 * The desktop owner still validates on arrival (`apps/epicenter/src/server.ts`),
 * which is where a check has to live anyway: a brand is a compile-time fact,
 * and a request crossing the sidecar carries no types.
 */
export type DatabaseName = string & Brand<'DatabaseName'>;

/** Validate a SQL account at the wire boundary. Only explicit null is local. */
export function isSqliteAccount(
	value: unknown,
): value is AccountIdentity | null {
	if (value === null) return true;
	if (typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	return (
		'authorityId' in value &&
		'principalId' in value &&
		isPathSegment(value.authorityId) &&
		isPathSegment(value.principalId)
	);
}

function isPathSegment(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value !== '.' &&
		value !== '..' &&
		!value.includes('\0') &&
		!value.includes('/') &&
		!value.includes('\\')
	);
}

/** One label a secret is filed under (ADR-0310), branded for the same reason. */
export type SecretLabel = string & Brand<'SecretLabel'>;

/** One SQLite database an application may name through `sqlite.open`. */
export function isDatabaseName(value: string): value is DatabaseName {
	return /^[a-z][a-z0-9_-]*$/.test(value);
}

/**
 * One label a secret may be filed under.
 *
 * Wider than anything that flows through it today: an Epicenter Data row id is
 * 24 lowercase alphanumerics. It is deliberately not narrowed to that, because
 * the label is the APPLICATION's to mint (ADR-0310) and this protocol has no
 * business assuming which minting an application uses. What it does refuse is
 * anything that could be read as a path or a separator, which is what keeps two
 * different pairs from naming one entry in the credential store.
 */
export function isSecretLabel(value: string): value is SecretLabel {
	return /^[A-Za-z0-9._-]+$/.test(value);
}

export type SqliteStatement = {
	sql: string;
	parameters?: readonly SqliteValue[];
};

type SqliteAddress = { appId: string; replica: LibraryReplicaIdentity };
type SqliteSession = SqliteAddress & { lifetimeId: string };

export type DeviceRequest =
	| (SqliteSession & {
			kind: 'sqlite-query';
			connectionId: string;
			queryId: string;
			statement: SqliteStatement;
			tables: readonly string[];
	  })
	| (SqliteSession & {
			kind: 'sqlite-cancel';
			connectionId: string;
			queryId: string;
	  })
	| (SqliteAddress & { kind: 'sqlite-acquire' })
	| (SqliteSession & { kind: 'sqlite-open'; name: string })
	| (SqliteSession & { kind: 'sqlite-close' })
	| (SqliteSession & { kind: 'sqlite-delete'; name: string })
	| (SqliteSession & {
			kind: 'sqlite-run';
			connectionId: string;
			statement: SqliteStatement;
	  })
	| (SqliteSession & {
			kind: 'sqlite-all';
			connectionId: string;
			statement: SqliteStatement;
	  })
	| (SqliteSession & {
			kind: 'sqlite-batch';
			connectionId: string;
			statements: readonly SqliteStatement[];
	  })
	| {
			kind: 'secret-put';
			appId: string;
			account: AccountIdentity | null;
			label: string;
			value: string;
	  }
	| {
			kind: 'secret-get';
			appId: string;
			account: AccountIdentity | null;
			label: string;
	  }
	| {
			kind: 'secret-delete';
			appId: string;
			account: AccountIdentity | null;
			label: string;
	  };

export type DeviceResponse =
	| { kind: 'sqlite-query'; result: QueryResult }
	| { kind: 'sqlite-cancel' }
	| { kind: 'sqlite-acquire'; lifetimeId: string }
	| { kind: 'sqlite-open'; connectionId: string }
	| { kind: 'sqlite-close' }
	| { kind: 'sqlite-run'; changes: number }
	| { kind: 'sqlite-all'; rows: readonly Record<string, unknown>[] }
	| { kind: 'sqlite-batch'; changes: readonly number[] }
	| { kind: 'sqlite-delete' }
	| { kind: 'secret-put' }
	| { kind: 'secret-get'; value: string | null }
	| { kind: 'secret-delete' };

const RESPONSE_KINDS: readonly DeviceResponse['kind'][] = [
	'sqlite-query',
	'sqlite-cancel',
	'sqlite-acquire',
	'sqlite-open',
	'sqlite-close',
	'sqlite-run',
	'sqlite-all',
	'sqlite-batch',
	'sqlite-delete',
	'secret-put',
	'secret-get',
	'secret-delete',
];

export function isDeviceResponse(value: unknown): value is DeviceResponse {
	if (typeof value !== 'object' || value === null || !('kind' in value)) {
		return false;
	}
	if (value.kind === 'sqlite-query')
		return 'result' in value && isQueryResult(value.result);
	if (value.kind === 'sqlite-acquire')
		return (
			'lifetimeId' in value &&
			typeof value.lifetimeId === 'string' &&
			value.lifetimeId.length > 0
		);
	if (value.kind === 'sqlite-open')
		return (
			'connectionId' in value &&
			typeof value.connectionId === 'string' &&
			value.connectionId.length > 0
		);
	return RESPONSE_KINDS.includes(value.kind as DeviceResponse['kind']);
}

/** JSON transport preserves SQLite binary values; query blobs retain their hex tag. */
export function stringifySqliteFrame(frame: object): string {
	return JSON.stringify(frame, (_key, value: unknown) => {
		if (value instanceof Uint8Array) return { blob: [...value] };
		if (typeof value === 'number' && !Number.isFinite(value))
			throw new Error('SQLite numbers must be finite.');
		return value;
	});
}

/** Decode the wire's binary tag before validating request or response structure. */
export function parseSqliteFrame(text: string): unknown {
	try {
		return JSON.parse(text, (_key, value: unknown) => {
			if (
				typeof value !== 'object' ||
				value === null ||
				Array.isArray(value) ||
				!('blob' in value) ||
				!Array.isArray(value.blob)
			)
				return value;
			if (
				Object.keys(value).length !== 1 ||
				!value.blob.every(
					(byte) =>
						typeof byte === 'number' &&
						Number.isInteger(byte) &&
						byte >= 0 &&
						byte <= 255,
				)
			)
				throw new Error('Invalid SQLite blob.');
			return new Uint8Array(value.blob);
		});
	} catch {
		return undefined;
	}
}
