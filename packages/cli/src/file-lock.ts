/**
 * A lock across processes on this machine, held through one app action's
 * run and commit, so two runs of that app take turns. Each run is its own
 * process (`child.ts`), so the lock is the only queue.
 *
 * The lock is an exclusive SQLite transaction on its file, which writes
 * nothing. SQLite holds it with an operating-system file lock (`fcntl`),
 * which the system releases when the process ends, however it ends, so a
 * killed holder leaves nothing to recover. Bun has no `flock`, so this is the
 * one cross-process lock it can take without native code.
 */
import { Database } from 'bun:sqlite';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Take the lock file at `path`, made with its directory when missing, waiting
 * as long as another process holds it, by polling with timers, never by
 * blocking the event loop. Returns the function that releases it. A path that
 * is a link or not a regular file is refused, so the lock is never taken on a
 * database somewhere else.
 */
export async function takeFileLock(path: string): Promise<() => void> {
	const found = await lstat(path).catch((cause: { code?: string }) => {
		if (cause.code === 'ENOENT') return undefined;
		throw cause;
	});
	if (found !== undefined && !found.isFile())
		throw new Error(
			`${path} is ${found.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}, so it cannot be locked. Remove it, then try again.`,
		);
	if (found === undefined) await mkdir(dirname(path), { recursive: true });
	const database = new Database(path, { create: true });
	try {
		database.run('PRAGMA busy_timeout = 0');
		for (let pause = 1; ; pause = Math.min(pause * 2, 25)) {
			try {
				database.run('BEGIN EXCLUSIVE');
				return () => {
					try {
						database.run('ROLLBACK');
					} finally {
						database.close();
					}
				};
			} catch (cause) {
				const code = String((cause as { code?: unknown }).code);
				if (!/^SQLITE_(BUSY|LOCKED)/.test(code)) throw cause;
				await Bun.sleep(pause);
			}
		}
	} catch (cause) {
		database.close();
		throw cause;
	}
}
