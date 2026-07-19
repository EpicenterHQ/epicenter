import type { JsonObject } from '@epicenter/row-sync';
import type { SqliteDatabase } from '@epicenter/sqlite';

const STORAGE_VERSION = 3;
const ROWS_TABLE = 'rows';

/**
 * Open the local-only Device workspace store.
 *
 * Scalar rows live here; row documents live in the workspace's SQLite
 * update log (`workspace_document_updates`), owned by the document log in
 * the same file. There is no migration path: an unrecognized version fails
 * loudly instead of being read through a compatibility branch.
 */
export function initializeLocalWorkspaceStorage(sqlite: SqliteDatabase): void {
	sqlite.transaction(() => {
		const version =
			sqlite.all<{ user_version: number }>('PRAGMA user_version')[0]
				?.user_version ?? 0;
		if (version === 0) {
			sqlite.run(`
				CREATE TABLE "${ROWS_TABLE}" (
					table_key   TEXT NOT NULL,
					row_id      TEXT NOT NULL,
					fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
					PRIMARY KEY(table_key, row_id)
				) WITHOUT ROWID, STRICT;
			`);
			sqlite.run(`PRAGMA user_version = ${STORAGE_VERSION}`);
			return;
		}

		if (version !== STORAGE_VERSION) {
			throw new Error('Incompatible local workspace storage');
		}
	});
}

/** Read one row directly from local confirmed storage. */
export function readLocalRow(
	sqlite: SqliteDatabase,
	table: string,
	rowId: string,
): JsonObject | undefined {
	const stored = sqlite.all<{ fields_json: string }>(
		`SELECT fields_json FROM "${ROWS_TABLE}"
		 WHERE table_key = ? AND row_id = ?`,
		[table, rowId],
	)[0];
	return stored ? JSON.parse(stored.fields_json) : undefined;
}

/** List one local table in stable row-id order. */
export function listLocalRows(
	sqlite: SqliteDatabase,
	table: string,
): { rowId: string; fields: JsonObject }[] {
	return sqlite
		.all<{ row_id: string; fields_json: string }>(
			`SELECT row_id, fields_json FROM "${ROWS_TABLE}"
			 WHERE table_key = ? ORDER BY row_id`,
			[table],
		)
		.map(({ row_id, fields_json }) => ({
			rowId: row_id,
			fields: JSON.parse(fields_json),
		}));
}
