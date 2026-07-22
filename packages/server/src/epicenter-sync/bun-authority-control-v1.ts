import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FORMAT_VERSION = 2;
const LIFETIME =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACTIVE_AUTHORITY_SCHEMA = `CREATE TABLE active_authority (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	format_version INTEGER NOT NULL CHECK (format_version = 2),
	authority_lifetime TEXT NOT NULL UNIQUE
) STRICT`;
const RESTORE_REQUESTS_SCHEMA = `CREATE TABLE restore_requests (
	request_id TEXT PRIMARY KEY
		CHECK (length(request_id) = 24 AND request_id NOT GLOB '*[^a-z0-9]*'),
	backup_id TEXT NOT NULL
		CHECK (length(backup_id) = 24 AND backup_id NOT GLOB '*[^a-z0-9]*'),
	successor_lifetime TEXT NOT NULL UNIQUE,
	record_count INTEGER NOT NULL
		CHECK (record_count BETWEEN 0 AND 9007199254740991),
	state TEXT NOT NULL CHECK (state IN ('building', 'succeeded'))
) STRICT`;
const CONTROL_SCHEMAS = [
	ACTIVE_AUTHORITY_SCHEMA,
	RESTORE_REQUESTS_SCHEMA,
] as const;
const REQUEST_ID = /^[a-z0-9]{24}$/u;

type ActiveRow = {
	format_version: number;
	authority_lifetime: string;
};

export type BunRestoreRequestV1 = {
	requestId: string;
	backupId: string;
	successorLifetime: string;
	recordCount: number;
	state: 'building' | 'succeeded';
};

type RestoreRequestRow = {
	request_id: string;
	backup_id: string;
	successor_lifetime: string;
	record_count: number;
	state: 'building' | 'succeeded';
};

type TableColumn = {
	name: string;
	type: string;
	notnull: number;
	pk: number;
	hidden: number;
};

function requireLifetime(value: string): void {
	if (!LIFETIME.test(value)) {
		throw new Error('Bun authority lifetime must be a lowercase UUID');
	}
}

function requireRequestId(value: string, label: string): void {
	if (!REQUEST_ID.test(value)) {
		throw new Error(`${label} must be 24 lowercase alphanumeric characters`);
	}
}

function requireRecordCount(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error('Bun Restore record count must be a non-negative integer');
	}
}

export type BunAuthorityActivation =
	| { kind: 'activated' }
	| { kind: 'unchanged'; cause: unknown }
	| {
			kind: 'indeterminate';
			cause: unknown;
			selected: string | undefined;
	  };

/** Classify a failed activation by rereading its durable postcondition. */
export function reconcileBunAuthorityActivationFailure({
	casMiss,
	cause,
	expectedLifetime,
	successorLifetime,
	readActive,
}: {
	casMiss: boolean;
	cause: unknown;
	expectedLifetime: string;
	successorLifetime: string;
	readActive(): string | undefined;
}): BunAuthorityActivation {
	if (casMiss) return { kind: 'unchanged', cause };
	try {
		const selected = readActive();
		if (selected === successorLifetime) return { kind: 'activated' };
		if (selected === expectedLifetime) return { kind: 'unchanged', cause };
		return { kind: 'indeterminate', cause, selected };
	} catch (proofCause) {
		return {
			kind: 'indeterminate',
			cause: new AggregateError(
				[cause, proofCause],
				'Bun authority activation and reconciliation failed',
			),
			selected: undefined,
		};
	}
}

/** Durable host pointer whose transaction commit is Bun Restore activation. */
export function openBunAuthorityControlV1(directory: string) {
	mkdirSync(directory, { recursive: true });
	const raw = new Database(join(directory, 'control-v1.sqlite'), {
		create: true,
		strict: true,
	});
	raw.run('PRAGMA busy_timeout = 0');
	try {
		raw.run('PRAGMA journal_mode = WAL');
		raw.run('PRAGMA synchronous = FULL');
	} catch (cause) {
		raw.close();
		throw cause;
	}
	const objects = raw
		.query<{ name: string; type: string; sql: string }, []>(
			`SELECT name, type, sql FROM sqlite_schema
			WHERE name NOT LIKE 'sqlite_%'
			ORDER BY type, name`,
		)
		.all();
	if (objects.length === 0) {
		raw.transaction(() => {
			for (const schema of CONTROL_SCHEMAS) raw.run(schema);
		})();
	} else if (
		objects.length !== CONTROL_SCHEMAS.length ||
		objects.some(
			(object, index) =>
				object.type !== 'table' || object.sql !== CONTROL_SCHEMAS[index],
		)
	) {
		raw.close();
		throw new Error('Bun authority control schema is not recognized');
	}
	const table = raw
		.query<{ name: string; wr: number; strict: number }, []>(
			`PRAGMA table_list('active_authority')`,
		)
		.all();
	const columns = raw
		.query<TableColumn, []>(`PRAGMA table_xinfo('active_authority')`)
		.all();
	const expectedColumns = [
		['singleton', 'INTEGER', 0, 1, 0],
		['format_version', 'INTEGER', 1, 0, 0],
		['authority_lifetime', 'TEXT', 1, 0, 0],
	] as const;
	if (
		table.length !== 1 ||
		table[0]?.name !== 'active_authority' ||
		table[0].strict !== 1 ||
		table[0].wr !== 0 ||
		columns.length !== expectedColumns.length ||
		columns.some((column, index) => {
			const expected = expectedColumns[index];
			return (
				expected === undefined ||
				column.name !== expected[0] ||
				column.type !== expected[1] ||
				column.notnull !== expected[2] ||
				column.pk !== expected[3] ||
				column.hidden !== expected[4]
			);
		})
	) {
		raw.close();
		throw new Error('Bun authority control table shape is not recognized');
	}

	function active(): string | undefined {
		const rows = raw
			.query<ActiveRow, []>(
				`SELECT format_version, authority_lifetime
				FROM active_authority WHERE singleton = 1`,
			)
			.all();
		if (rows.length === 0) return undefined;
		const row = rows[0];
		if (
			rows.length !== 1 ||
			row === undefined ||
			row.format_version !== FORMAT_VERSION
		) {
			throw new Error('Bun authority control metadata is not recognized');
		}
		requireLifetime(row.authority_lifetime);
		return row.authority_lifetime;
	}

	function restoreRequest(requestId: string): BunRestoreRequestV1 | undefined {
		requireRequestId(requestId, 'Bun Restore request ID');
		const rows = raw
			.query<RestoreRequestRow, [string]>(
				`SELECT request_id, backup_id, successor_lifetime, record_count, state
				FROM restore_requests WHERE request_id = ?`,
			)
			.all(requestId);
		if (rows.length === 0) return undefined;
		const row = rows[0];
		if (rows.length !== 1 || row === undefined) {
			throw new Error('Bun Restore request is not recognized');
		}
		requireRequestId(row.request_id, 'Bun Restore request ID');
		requireRequestId(row.backup_id, 'Bun Backup ID');
		requireLifetime(row.successor_lifetime);
		requireRecordCount(row.record_count);
		if (row.state !== 'building' && row.state !== 'succeeded') {
			throw new Error('Bun Restore request is not recognized');
		}
		return {
			requestId: row.request_id,
			backupId: row.backup_id,
			successorLifetime: row.successor_lifetime,
			recordCount: row.record_count,
			state: row.state,
		};
	}

	function activeRestoreRequest(): BunRestoreRequestV1 | undefined {
		const rows = raw
			.query<{ request_id: string }, []>(
				`SELECT request_id FROM restore_requests WHERE state = 'building'`,
			)
			.all();
		if (rows.length === 0) return undefined;
		if (rows.length !== 1 || rows[0] === undefined) {
			throw new Error('Bun Restore active request is not recognized');
		}
		return restoreRequest(rows[0].request_id);
	}

	return Object.freeze({
		active,
		restoreRequest,
		activeRestoreRequest,
		initialize(authorityLifetime: string): void {
			requireLifetime(authorityLifetime);
			raw.transaction(() => {
				if (active() !== undefined) {
					throw new Error('Bun authority control is already initialized');
				}
				raw.run(
					`INSERT INTO active_authority (
						singleton, format_version, authority_lifetime
					) VALUES (1, ?, ?)`,
					[FORMAT_VERSION, authorityLifetime],
				);
			})();
		},
		activate(expectedLifetime: string, successorLifetime: string) {
			requireLifetime(expectedLifetime);
			requireLifetime(successorLifetime);
			let casMiss = false;
			try {
				raw.transaction(() => {
					const result = raw
						.query<never, [string, string]>(
							`UPDATE active_authority SET authority_lifetime = ?
							WHERE singleton = 1 AND authority_lifetime = ?`,
						)
						.run(successorLifetime, expectedLifetime);
					if (result.changes !== 1) {
						casMiss = true;
						throw new Error(
							'Bun authority activation lost its compare-and-swap',
						);
					}
				})();
				return { kind: 'activated' } as const;
			} catch (cause) {
				return reconcileBunAuthorityActivationFailure({
					casMiss,
					cause,
					expectedLifetime,
					successorLifetime,
					readActive: active,
				});
			}
		},
		beginRestore(
			requestId: string,
			backupId: string,
			successorLifetime: string,
			recordCount: number,
		): BunRestoreRequestV1 {
			requireRequestId(requestId, 'Bun Restore request ID');
			requireRequestId(backupId, 'Bun Backup ID');
			requireLifetime(successorLifetime);
			requireRecordCount(recordCount);
			return raw.transaction(() => {
				if (restoreRequest(requestId) !== undefined) {
					throw new Error('Bun Restore request already exists');
				}
				if (activeRestoreRequest() !== undefined) {
					throw new Error('Bun Restore is already active');
				}
				raw.run(
					`INSERT INTO restore_requests
					(request_id, backup_id, successor_lifetime, record_count, state)
					VALUES (?, ?, ?, ?, 'building')`,
					[requestId, backupId, successorLifetime, recordCount],
				);
				const created = restoreRequest(requestId);
				if (created === undefined) {
					throw new Error('Bun Restore request was not persisted');
				}
				return created;
			})();
		},
		completeRestore(requestId: string): BunRestoreRequestV1 {
			requireRequestId(requestId, 'Bun Restore request ID');
			raw.run(
				`UPDATE restore_requests SET state = 'succeeded'
				WHERE request_id = ? AND state = 'building'`,
				[requestId],
			);
			const completed = restoreRequest(requestId);
			if (completed?.state !== 'succeeded') {
				throw new Error('Bun Restore request did not complete');
			}
			return completed;
		},
		abandonRestore(requestId: string): void {
			requireRequestId(requestId, 'Bun Restore request ID');
			raw.run(
				`DELETE FROM restore_requests
				WHERE request_id = ? AND state = 'building'`,
				[requestId],
			);
		},
		close(): void {
			raw.close();
		},
	});
}

export type BunAuthorityControlV1 = ReturnType<
	typeof openBunAuthorityControlV1
>;

/** Hold exclusive ownership of one principal until the returned owner closes. */
export function acquireBunAuthorityOwnerV1(directory: string) {
	mkdirSync(directory, { recursive: true });
	const raw = new Database(join(directory, 'owner-v1.sqlite'), {
		create: true,
	});
	raw.run('PRAGMA busy_timeout = 0');
	try {
		raw.run('BEGIN EXCLUSIVE');
	} catch (cause) {
		raw.close();
		throw new Error('Bun authority principal is already owned', { cause });
	}
	let closed = false;
	return Object.freeze({
		close(): void {
			if (closed) return;
			closed = true;
			try {
				raw.run('ROLLBACK');
			} finally {
				raw.close();
			}
		},
	});
}
