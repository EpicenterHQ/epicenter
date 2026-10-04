import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { mailMirror, openMailDbReadonly } from './db.ts';

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
	// The opener reports absence rather than conjuring a file, so there is no
	// existence check to race against the sync that may be creating it.
	const db = openMailDbReadonly({ dataDir, accountEmail });
	if (db === null) {
		return MailQueryError.NoMirror({
			path: mailMirror(dataDir, accountEmail).path,
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
