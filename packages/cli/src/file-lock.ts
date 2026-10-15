/**
 * One process at a time, across every `epicenter` process on this machine:
 * an exclusive SQLite transaction on a lock file, which the system releases
 * if the process dies, so a process killed mid-refresh never leaves the lock
 * held. `auth token`, `auth git-credential`, and `send` refresh a grant under
 * it (ADR-0549), so two processes never spend one refresh token.
 *
 * `bun:sqlite` is synchronous, so a busy timeout would block this process's
 * own holder; the lock is polled instead.
 */

import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const POLL_MS = 20;

/**
 * Run `work` while holding the lock at `path`, waiting at most `timeoutMs`
 * for it. The lock is released when `work` settles, whatever it returns.
 */
export async function withFileLock<T>(
	path: string,
	work: () => Promise<T>,
	{ timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<T> {
	await mkdir(dirname(path), { recursive: true });
	const lock = new Database(path, { create: true });
	try {
		lock.exec('PRAGMA busy_timeout = 0');
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				lock.exec('BEGIN EXCLUSIVE');
				break;
			} catch (error) {
				if (!/locked|busy/i.test(String(error))) throw error;
				if (Date.now() > deadline)
					throw new Error(
						`another epicenter process has held ${path} for over ${Math.round(timeoutMs / 1000)} seconds`,
					);
				await Bun.sleep(POLL_MS);
			}
		}
		try {
			return await work();
		} finally {
			lock.exec('COMMIT');
		}
	} finally {
		lock.close();
	}
}
