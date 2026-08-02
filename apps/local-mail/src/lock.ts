import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { ensureAccountDir } from './paths.ts';

/**
 * The per-account reconcile-owner lock. The runtime invariant is: at most one
 * active reconciler per account, and the reconciler is the only thing that
 * writes to Gmail, so this lock now names the account's single writer rather
 * than just its single puller. Reads (`query`/`status`) open the mirror
 * read-only and triage acts only write the local intent store, so neither needs
 * it. The holders are the open desktop `app` (holds it for its whole lifetime
 * while its loop runs), a CLI `reconcile --watch` loop, and a one-shot act or
 * `reconcile` for the duration of its single pass.
 *
 * A dedicated `lock.db` held with `BEGIN EXCLUSIVE` is the lock: a second holder
 * fails to open the transaction instantly (`busy_timeout = 0`) and yields rather
 * than racing a second bulk pull. `flock` has no Bun API and an `O_EXCL` lockfile
 * is stale-on-crash; the fcntl lock a live SQLite transaction holds is released
 * by the kernel on `kill -9`, so a crashed owner never wedges the next sync.
 * SQLite tracks open connections per process, so this also refuses a second
 * in-process holder, not just a second process.
 */

export type ReconcileLock = { release(): void };

/**
 * Try to become the reconcile owner for `<dataDir>/<accountEmail>`. Returns the
 * lock to `release()` when the pass or loop ends, or `null` when another owner
 * (the open app, another reconcile) already holds it. The account directory is
 * created if missing so the very first pass after `connect` can take the lock
 * before the mirror db exists.
 */
export function acquireReconcileLock({
	dataDir,
	accountEmail,
}: {
	dataDir: string;
	accountEmail: string;
}): ReconcileLock | null {
	const accountDir = ensureAccountDir(dataDir, accountEmail);
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
 * The message a headless pass prints (CLI) or returns (MCP) when another owner
 * already holds the lock. It exits cleanly: nothing failed, and whoever owns the
 * loop delivers the pending assertions and keeps the mirror fresh.
 */
export function reconcileOwnerBusyMessage(accountEmail: string): string {
	return `Local Mail is already reconciling ${accountEmail} (the app is open, or another pass is running). Skipping; that owner delivers pending changes and keeps the mirror fresh.`;
}

/**
 * The structured yield a headless pass emits when another owner holds the lock:
 * `local-mail reconcile --json` prints it on stdout and the MCP `reconcile` tool
 * returns it as `Ok`. `reconciled: false` is the discriminant against a real
 * `ReconcileOutcome` (which has no `reconciled` field); `reason` is a stable
 * machine token; `message` is human.
 */
export type ReconcileOwnerBusy = {
	reconciled: false;
	reason: 'reconcile-owner-active';
	message: string;
};

export function reconcileOwnerBusy(accountEmail: string): ReconcileOwnerBusy {
	return {
		reconciled: false,
		reason: 'reconcile-owner-active',
		message: reconcileOwnerBusyMessage(accountEmail),
	};
}
