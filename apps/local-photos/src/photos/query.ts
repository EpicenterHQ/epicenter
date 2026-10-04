import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';

const MAX_ROWS = 1000;

export type PhotosQueryResult = {
	rows: Record<string, unknown>[];
	rowCount: number;
	truncated: boolean;
};

/** Run bounded ad-hoc SQL through a read-only SQLite connection. */
export function queryPhotos({
	dbPath,
	sql,
}: {
	dbPath: string;
	sql: string;
}): PhotosQueryResult {
	if (!existsSync(dbPath)) {
		throw new Error(
			`No Local Photos archive at ${dbPath}. Run an import first.`,
		);
	}
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows: Record<string, unknown>[] = [];
		let truncated = false;
		for (const row of db.query(sql).iterate()) {
			if (rows.length === MAX_ROWS) {
				truncated = true;
				break;
			}
			rows.push(row as Record<string, unknown>);
		}
		return { rows, rowCount: rows.length, truncated };
	} finally {
		db.close();
	}
}
