/**
 * Whether another process holds a folder's lock, for `examples/quit`.
 *
 *   bun lock-probe.ts <lock file>
 *
 * The folder plugin holds an exclusive SQLite transaction on the file beside
 * a folder it granted (`packages/tauri-plugin-epicenter-folder/core/src/lock.rs`). This
 * asks for the same transaction from another process, without waiting, and
 * prints `busy` or `free`. Taken, it is released at once. Any other failure,
 * including a missing file, throws and exits non-zero.
 */
import { Database } from 'bun:sqlite';

/** `SQLITE_BUSY` and `SQLITE_LOCKED`. */
const BUSY = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);
const BUSY_ERRNO = new Set([5, 6]);

const path = process.argv[2];
if (path === undefined) throw new Error('lock-probe.ts needs the lock file');
const database = new Database(path, { readwrite: true, create: false });
let state: 'busy' | 'free';
try {
	database.exec('PRAGMA busy_timeout = 0');
	try {
		database.exec('BEGIN EXCLUSIVE');
		database.exec('ROLLBACK');
		state = 'free';
	} catch (cause) {
		const { code, errno } = cause as { code?: string; errno?: number };
		if (!BUSY.has(code ?? '') && !BUSY_ERRNO.has(errno ?? -1)) throw cause;
		state = 'busy';
	}
} finally {
	database.close();
}
console.log(state);
