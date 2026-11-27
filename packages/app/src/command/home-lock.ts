import { Database, SQLiteError } from 'bun:sqlite';
import { join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { ActionError } from '../answer.ts';

/** Keep the write transaction open in a dedicated database until serve exits. */
export function lockHome(state: string) {
	let lock: Database | undefined;
	try {
		lock = new Database(join(state, 'serve-lock.sqlite'), { create: true });
		lock.run('PRAGMA busy_timeout = 0');
		lock.run('BEGIN IMMEDIATE');
		return Ok(lock);
	} catch (cause) {
		lock?.close();
		return ActionError.NotStarted({
			message:
				cause instanceof SQLiteError && cause.code === 'SQLITE_BUSY'
					? 'Epicenter is already running for this home.'
					: `serve could not lock this home: ${extractErrorMessage(cause)}`,
		});
	}
}
