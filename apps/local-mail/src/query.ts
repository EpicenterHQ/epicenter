import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { openMailDbReadonly } from './db.ts';
import { mailDbPath } from './paths.ts';

export const MailQueryError = defineErrors({
	NoMirror: ({ path }: { path: string }) => ({
		message: `No Gmail mirror at ${path}. Run "local-mail sync --full" first.`,
	}),
	QueryFailed: ({ cause }: { cause: unknown }) => ({
		message: `Read-only query failed (the mirror rejects writes): ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MailQueryError = InferErrors<typeof MailQueryError>;

const MAX_ROWS = 1000;

export type MailQueryResult = {
	rows: Record<string, unknown>[];
	rowCount: number;
	truncated: boolean;
};

export function queryMail({
	dataDir,
	accountEmail,
	sql,
}: {
	dataDir: string;
	accountEmail: string;
	sql: string;
}): Result<MailQueryResult, MailQueryError> {
	// The reader never creates a file, so an absent mailbox is reported rather
	// than conjured: querying an account that has never synced leaves the
	// directory exactly as it was.
	const db = openMailDbReadonly({ dataDir, accountEmail });
	if (db === null) {
		return MailQueryError.NoMirror({
			path: mailDbPath(dataDir, accountEmail),
		});
	}
	try {
		const rows: Record<string, unknown>[] = [];
		let truncated = false;
		for (const row of db.raw.query(sql).iterate()) {
			if (rows.length === MAX_ROWS) {
				truncated = true;
				break;
			}
			rows.push(row as Record<string, unknown>);
		}
		return Ok({ rows, rowCount: rows.length, truncated });
	} catch (cause) {
		return MailQueryError.QueryFailed({ cause });
	} finally {
		db.close();
	}
}
