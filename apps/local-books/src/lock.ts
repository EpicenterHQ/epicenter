import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type SyncLock = { release(): void };

/**
 * Try to become the only sync owner for one QuickBooks realm.
 *
 * The desktop app, `sync`, `watch`, and MCP refresh all use this lock. Reads
 * never take it. A dedicated SQLite transaction gives the lock crash-safe
 * kernel lifetime without placing a stale PID or lockfile on disk.
 */
export function acquireSyncLock({
	dataDir,
	realmId,
}: {
	dataDir: string;
	realmId: string;
}): SyncLock | null {
	const realmDir = join(dataDir, realmId);
	mkdirSync(realmDir, { recursive: true });
	const db = new Database(join(realmDir, 'sync-lock.db'), { create: true });
	db.run('PRAGMA busy_timeout = 0;');
	try {
		db.run('BEGIN EXCLUSIVE;');
	} catch {
		db.close();
		return null;
	}
	return {
		release() {
			try {
				db.run('ROLLBACK;');
			} catch {
				// The kernel releases the lock when a terminating process closes it.
			}
			db.close();
		},
	};
}

export function syncOwnerBusyMessage(realmId: string): string {
	return `Local Books is already syncing company ${realmId}. Skipping; the mirror is being kept fresh by the app or another sync command.`;
}
