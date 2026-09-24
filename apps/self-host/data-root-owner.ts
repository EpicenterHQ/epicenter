import { Database } from 'bun:sqlite';
import { join } from 'node:path';

/** SQLite's process-held exclusive transaction releases automatically on exit. */
export function acquireDataRootOwner(root: string) {
	const database = new Database(join(root, 'owner.sqlite'), { create: true });
	try {
		database.exec('PRAGMA busy_timeout = 0');
		database.exec('PRAGMA journal_mode = DELETE');
		database.exec('BEGIN EXCLUSIVE');
	} catch (error) {
		database.close();
		throw new Error(`Another Bun server owns data root ${root}`, {
			cause: error,
		});
	}
	return () => {
		database.exec('ROLLBACK');
		database.close();
	};
}
