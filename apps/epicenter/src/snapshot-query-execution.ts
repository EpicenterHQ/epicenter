import { Database } from 'bun:sqlite';

export const MAX_SNAPSHOT_QUERY_LENGTH = 100_000;
const MAX_QUERY_ROWS = 500;
const MAX_QUERY_RESULT_BYTES = 5 * 1024 * 1024;

export type HomeSnapshotQueryResult = {
	rows: Record<string, string | number | null>[];
	rowCount: number;
	truncated: boolean;
};

function requireReadStatement(sql: string): void {
	if (!/^(?:SELECT|WITH|VALUES|EXPLAIN)\b/iu.test(sql.trimStart())) {
		throw new Error(
			'Snapshot queries must begin with SELECT, WITH, VALUES, or EXPLAIN',
		);
	}
}

function queryValue(value: unknown): string | number | null {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number'
	) {
		return value;
	}
	if (value instanceof Uint8Array) {
		if (value.byteLength > MAX_QUERY_RESULT_BYTES) {
			throw new Error('Snapshot query returned a BLOB larger than 5 MiB');
		}
		return `base64:${value.toBase64()}`;
	}
	throw new Error('Snapshot query returned an unsupported SQLite value');
}

/** Execute one bounded read against an inert artifact inside an isolated process. */
export function executeSnapshotQuery(
	path: string,
	sql: string,
): HomeSnapshotQueryResult {
	if (sql.trim() === '' || sql.length > MAX_SNAPSHOT_QUERY_LENGTH) {
		throw new Error(
			'Snapshot query must be nonempty and at most 100000 characters',
		);
	}
	requireReadStatement(sql);
	const database = new Database(path, { readonly: true, strict: true });
	try {
		database.exec('PRAGMA query_only = ON');
		const rows: HomeSnapshotQueryResult['rows'] = [];
		let encodedBytes = Buffer.byteLength(
			'{"rows":[],"rowCount":500,"truncated":false}',
		);
		let truncated = false;
		for (const raw of database.query(sql).iterate()) {
			if (rows.length === MAX_QUERY_ROWS) {
				truncated = true;
				break;
			}
			const row = Object.fromEntries(
				Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
					key,
					queryValue(value),
				]),
			);
			const rowBytes = Buffer.byteLength(JSON.stringify(row)) + 1;
			if (encodedBytes + rowBytes > MAX_QUERY_RESULT_BYTES) {
				truncated = true;
				break;
			}
			encodedBytes += rowBytes;
			rows.push(row);
		}
		return { rows, rowCount: rows.length, truncated };
	} finally {
		database.close();
	}
}
