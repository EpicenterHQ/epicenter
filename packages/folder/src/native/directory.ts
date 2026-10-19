/**
 * What the native Bun folder keeps beside its directory, never in it: the
 * save lock, and the scratch directory where a new file's bytes are staged.
 * Neither needs Git, so a directory without `.git`, or with a `.git` file or
 * link, opens and saves alike, and saving creates nothing inside it but the
 * files saved.
 *
 * The save lock is the one the desktop shell's `lock.rs` takes too: an
 * exclusive SQLite transaction on `.<name>.epicenter-save-lock` beside the
 * directory (ADR-0562). The history lock beside it is the CLI's
 * (`runHistory` in `../bun.ts`). The scratch directory is
 * `.<name>.epicenter-scratch` beside it, on the parent's file system, so a
 * directory that is itself a mount point cannot be saved to.
 */
import { Database } from 'bun:sqlite';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { NothingChanged } from '../errors.js';
import { createMutex } from '../git/mutex.js';

/**
 * `directory` with its links resolved, or why it cannot hold a folder: it is
 * not a directory, or it has no parent to keep its save lock and scratch
 * directory in. What `.git` is, if anything, does not matter.
 */
export async function localRoot(
	directory: string,
): Promise<Result<string, { root: string; cause: unknown }>> {
	try {
		const resolved = await realpath(directory);
		if (!(await lstat(resolved)).isDirectory())
			throw new Error(`${directory} is not a directory`);
		if (dirname(resolved) === resolved)
			throw new Error(
				`${directory} has no parent directory to hold its save lock`,
			);
		return Ok(resolved);
	} catch (cause) {
		return Err({ root: directory, cause });
	}
}

/** `.<name>.epicenter-scratch` beside the directory at `resolved`. */
export const scratchDirectory = (resolved: string) =>
	join(dirname(resolved), `.${basename(resolved)}.epicenter-scratch`);

/** How long a save waits for another process's save to the same directory. */
const SAVE_LOCK_WAIT_MS = 10_000;

/**
 * Run `work`, one check and one change, holding the save lock of the
 * directory at `resolved`. A save that cannot take it within
 * `SAVE_LOCK_WAIT_MS` throws `NothingChanged` before `work` runs.
 */
export function holdingSaveLock<T>(
	resolved: string,
	work: () => Promise<T>,
): Promise<T> {
	return holdingFolderLock(resolved, 'save', SAVE_LOCK_WAIT_MS, work);
}

/** How long a history operation waits for another process's. */
const HISTORY_LOCK_WAIT_MS = 60_000;

/**
 * Run `work`, one whole history operation (a save version or a sync),
 * holding the history lock of the directory at `resolved`: an exclusive
 * SQLite transaction on `.<name>.epicenter-history-lock` beside it, the
 * mechanism of the save lock, held by whichever process runs the operation
 * (ADR-0559). Two `epicenter` processes take turns, so a commit never lands
 * between a sync's checkpoint and its merge. It is apart from the save lock,
 * so saves never wait on a sync's network. Reading status or history takes
 * no lock. Waits up to `HISTORY_LOCK_WAIT_MS`, then throws before `work`
 * runs.
 */
export function holdingHistoryLock<T>(
	resolved: string,
	work: () => Promise<T>,
): Promise<T> {
	return holdingFolderLock(resolved, 'history', HISTORY_LOCK_WAIT_MS, work);
}

/** What each folder lock guards, for the message when it cannot be taken. */
const LOCKED = {
	save: (resolved: string) => `Nothing was saved to the folder at ${resolved}`,
	history: (resolved: string) =>
		`The history of the folder at ${resolved} was not changed`,
} as const;

/** `.<name>.epicenter-<kind>-lock` beside the directory at `resolved`. */
function holdingFolderLock<T>(
	resolved: string,
	kind: keyof typeof LOCKED,
	waitMs: number,
	work: () => Promise<T>,
): Promise<T> {
	const refused = LOCKED[kind](resolved);
	const parent = dirname(resolved);
	if (parent === resolved)
		return Promise.reject(
			new Error(
				`${refused}: it has no parent directory to hold its ${kind} lock.`,
			),
		);
	const path = join(parent, `.${basename(resolved)}.epicenter-${kind}-lock`);
	return holdingFileLock(
		path,
		{
			waitMs,
			held: `${refused}: another program held its ${kind} lock (${path}) for more than ${waitMs / 1000} seconds. Try again; if it keeps happening, quit the other program.`,
		},
		work,
	);
}

/** One turn at a time per lock file within this process, before the file lock. */
const lockTurns = new Map<string, ReturnType<typeof createMutex>>();

/**
 * Run `work` holding the lock file at `path`, made with its directory when
 * missing: an exclusive SQLite transaction, which writes nothing. SQLite
 * holds it with an operating-system file lock (`fcntl`), which the system
 * releases when the process ends, however it ends, so a killed holder leaves
 * nothing to recover. Bun has no `flock`, so this is the one cross-process
 * lock it can take without native code, and the desktop shell takes the same
 * kind (`lock.rs`). The folder's save and history locks, the CLI's sign-in
 * refresh, and its app installs all hold one.
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
	let turn = lockTurns.get(path);
	if (turn === undefined) {
		turn = createMutex();
		lockTurns.set(path, turn);
	}
	return turn.run(async () => {
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
	});
}

async function takeFileLock(
	path: string,
	waitMs: number,
	held: string,
): Promise<Database> {
	// Checked once, as the shell checks it.
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
