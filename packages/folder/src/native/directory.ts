/**
 * What the native Bun folder keeps in its directory's own `.epicenter`
 * (`STATE_DIRECTORY`), which no listing shows and no watcher reports: the
 * save lock, and the scratch directory where a new file's bytes are staged.
 * Neither needs Git, so a directory without `.git`, or with a `.git` file or
 * link, opens and saves alike, and saving creates nothing beside it and
 * nothing in it but the files saved and `.epicenter`.
 *
 * The save lock is the one the desktop shell's `lock.rs` takes too: an
 * exclusive SQLite transaction on `.epicenter/save-lock` (ADR-0562). The
 * scratch directory is `.epicenter/scratch`, on the directory's own file
 * system, so the rename over a path is one step. A link at `.epicenter` is
 * never followed.
 */
import { Database } from 'bun:sqlite';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { STATE_DIRECTORY } from '../boundary.js';
import { NothingChanged } from '../errors.js';
import { createMutex } from '../git/mutex.js';

/**
 * `directory` with its links resolved, or why it cannot hold a folder: it is
 * not a directory. What `.git` is, if anything, does not matter.
 */
export async function localRoot(
	directory: string,
): Promise<Result<string, { root: string; cause: unknown }>> {
	try {
		const resolved = await realpath(directory);
		if (!(await lstat(resolved)).isDirectory())
			throw new Error(`${directory} is not a directory`);
		return Ok(resolved);
	} catch (cause) {
		return Err({ root: directory, cause });
	}
}

/**
 * `.epicenter/scratch` inside the directory at `resolved`, written with `/`
 * as the directory storage writes its own paths, so its parent is the
 * directory's `.epicenter`.
 */
export const scratchDirectory = (resolved: string) =>
	`${resolved}/${STATE_DIRECTORY}/scratch`;

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

/** What each folder lock guards, for the message when it cannot be taken. */
const LOCKED = {
	save: (resolved: string) => `Nothing was saved to the folder at ${resolved}`,
} as const;

/**
 * `.epicenter/<kind>-lock` inside the directory at `resolved`, after making
 * `.epicenter` (`0700`) when it is missing. A link or anything but a
 * directory there refuses the lock as `NothingChanged`, so it is never
 * taken through a link.
 */
async function holdingFolderLock<T>(
	resolved: string,
	kind: keyof typeof LOCKED,
	waitMs: number,
	work: () => Promise<T>,
): Promise<T> {
	const refused = LOCKED[kind](resolved);
	const state = join(resolved, STATE_DIRECTORY);
	try {
		await mkdir(state, { mode: 0o700 }).catch((cause: { code?: string }) => {
			if (cause.code !== 'EEXIST') throw cause;
		});
		const found = await lstat(state);
		if (!found.isDirectory())
			throw new Error(
				`${state} is ${found.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}. Remove it, then save again.`,
			);
	} catch (cause) {
		throw new NothingChanged(
			new Error(`${refused}: ${(cause as Error).message}`),
		);
	}
	const path = join(state, `${kind}-lock`);
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
 * kind (`lock.rs`). The folder's save lock, the CLI's sign-in refresh, its
 * app installs, and each repository's sync turns all hold one.
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
