import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The per-account sync-owner lock. The runtime invariant is: at most one active
 * sync owner per account. Only the sync path takes this lock; reads
 * (`query`/`status`) open the mirror read-only, and triage writes go Gmail-first
 * with a best-effort local fold, so neither needs it. The holders are the open
 * desktop `app` (holds it for its whole lifetime while the loop runs), a CLI
 * `watch` loop, and a one-shot `sync` for the duration of its single pass.
 *
 * A dedicated `lock.db` held with `BEGIN EXCLUSIVE` is the lock: a second holder
 * fails to open the transaction instantly (`busy_timeout = 0`) and yields rather
 * than racing a second bulk pull. `flock` has no Bun API and an `O_EXCL` lockfile
 * is stale-on-crash; the fcntl lock a live SQLite transaction holds is released
 * by the kernel on `kill -9`, so a crashed owner never wedges the next sync.
 * SQLite tracks open connections per process, so this also refuses a second
 * in-process holder, not just a second process.
 */

export type SyncLock = { release(): void };

/**
 * Try to become the sync owner for `<dataDir>/<accountEmail>`. Returns the lock
 * to `release()` when the pass or loop ends, or `null` when another owner (the
 * open app, another sync) already holds it. The account directory is created if
 * missing so the very first `sync` after `connect` can take the lock before the
 * mirror db exists.
 */
export function acquireSyncLock({
	dataDir,
	accountEmail,
}: {
	dataDir: string;
	accountEmail: string;
}): SyncLock | null {
	const accountDir = join(dataDir, accountEmail);
	mkdirSync(accountDir, { recursive: true, mode: 0o700 });
	const db = new Database(join(accountDir, 'lock.db'), { create: true });
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
				// The process is exiting; the kernel drops the lock regardless.
			}
			db.close();
		},
	};
}

/**
 * The message a headless `sync` prints (CLI) or returns (MCP) when another owner
 * already holds the lock. It exits cleanly: nothing failed, the mirror is being
 * kept fresh by whoever owns the loop.
 */
export function syncOwnerBusyMessage(accountEmail: string): string {
	return `Local Mail is already syncing ${accountEmail} (the app is open, or another sync is running). Skipping; the mirror is being kept fresh.`;
}

/**
 * The structured yield a headless `sync` emits when another owner holds the lock:
 * `local-mail sync --json` prints it on stdout and the MCP `sync` tool returns it
 * as `Ok`. `synced: false` is the discriminant against a real `SyncOutcome` (which
 * has no `synced` field); `reason` is a stable machine token; `message` is human.
 */
export type SyncOwnerBusy = {
	synced: false;
	reason: 'sync-owner-active';
	message: string;
};

export function syncOwnerBusy(accountEmail: string): SyncOwnerBusy {
	return {
		synced: false,
		reason: 'sync-owner-active',
		message: syncOwnerBusyMessage(accountEmail),
	};
}
