/**
 * A lock across processes on this machine, held for the length of one piece
 * of work: the CLI's sign-in refresh (one per grant, so two processes never
 * spend one refresh token) and each repository's sync rounds
 * (`<git dir>/epicenter-sync.lock`).
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

/** The lock could not be taken, so the work it guards never ran. */
export class NothingChanged extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = 'NothingChanged';
	}
}

/** The end of each lock file's queue in this process, before the file lock. */
const turns = new Map<string, Promise<unknown>>();

/**
 * Run `work` holding the lock file at `path`, made with its directory when
 * missing.
 *
 * Work in this process takes turns first, so only one connection per lock
 * waits on the file lock, by polling with timers, never by blocking the
 * event loop. When another process still holds it after `waitMs` (at once,
 * for `0`), it throws `held` before `work` runs, as `NothingChanged`, which
 * every failure to take the lock is. A path that is a link or not a regular
 * file is refused, so the lock is never taken on a database somewhere else.
 */
export function holdingFileLock<T>(
	path: string,
	{ waitMs, held }: { readonly waitMs: number; readonly held: string },
	work: () => Promise<T>,
): Promise<T> {
	const turn = async () => {
		const database = await takeFileLock(path, waitMs, held).catch(
			(cause: unknown) => {
				throw new NothingChanged(cause);
			},
		);
		try {
			return await work();
		} finally {
			try {
				database.run('ROLLBACK');
			} finally {
				database.close();
			}
		}
	};
	const ahead = turns.get(path) ?? Promise.resolve();
	const result = ahead.then(turn, turn);
	const settled = result.then(
		() => {},
		() => {},
	);
	turns.set(path, settled);
	void settled.then(() => {
		if (turns.get(path) === settled) turns.delete(path);
	});
	return result;
}

async function takeFileLock(
	path: string,
	waitMs: number,
	held: string,
): Promise<Database> {
	// Checked once.
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
		const deadline = Date.now() + waitMs;
		for (let pause = 1; ; pause = Math.min(pause * 2, 25)) {
			try {
				database.run('BEGIN EXCLUSIVE');
				return database;
			} catch (cause) {
				const code = String((cause as { code?: unknown }).code);
				if (!/^SQLITE_(BUSY|LOCKED)/.test(code)) throw cause;
				if (Date.now() >= deadline) throw new Error(held);
				await Bun.sleep(pause);
			}
		}
	} catch (cause) {
		database.close();
		throw cause;
	}
}
