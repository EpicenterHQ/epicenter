/**
 * `@epicenter/folder/bun`: open an ordinary directory as a folder, in Bun.
 *
 * For command-line tools, recovery scripts, and tests that are given a
 * directory. `openFolder` opens it with a definition from code, which it
 * publishes to `epicenter.json`; `openDataFolder` opens an existing data
 * folder with its own `epicenter.json`, which it never writes; `readFolder`
 * reads one without opening it; `runHistory` runs one history operation, as
 * the `epicenter` CLI does for a desktop page. A page in the desktop app
 * opens its folder through `@epicenter/folder/tauri` instead, where the shell
 * grants the page its directory, changes its files, and runs `git` for it.
 *
 * Both open the same directory folder (`openDirectoryFolder`): files through
 * the browser folder's file storage over the directory, replaced by renaming a
 * staged copy over them, and history through the system `git`. Here this
 * process reaches the disk itself, with `node:fs` and its own `git`. The root
 * is explicit and the caller supplies the author for commits Git's
 * configuration does not attribute. The remote is `remote.origin.url` in the
 * directory's Git configuration.
 *
 * Saves to one directory take turns within this process, across every handle
 * it opens, and with every other process that takes the directory's save
 * lock: the desktop shell's checked renames and other Bun processes
 * (ADR-0562). The lock is an exclusive SQLite transaction on
 * `.<name>.epicenter-save-lock` beside the directory, the same one the shell
 * takes, held only across one rename or removal and the check of the observed
 * version just before it, so that check holds. A save waits up to ten
 * seconds for another process's; past that it fails and changes nothing.
 * Commits are kept apart by Git's lock files and the branch's
 * compare-and-swap. Nothing watches the directory, so `onFilesChanged`
 * reports this handle's own saves and incoming updates, not other programs'
 * edits.
 */

import { Database } from 'bun:sqlite';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { LockingStorage } from './boundary.js';
import { readDeclaration } from './declaration.js';
import type { FolderDefinition } from './definition.js';
import { openDirectoryFolder } from './directory-adapter.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import type { DirectoryPrimitives } from './directory-primitives.js';
import { createDirectoryStorage } from './directory-store.js';
import { OpenFolderError } from './errors.js';
import type { Folder, FolderGitOptions } from './folder.js';
import type { History } from './git/history.js';
import type { GitCredentials } from './git/http.js';
import { createMutex } from './git/mutex.js';
import { nativeHistory } from './git/native-history.js';
import {
	createGitRunner,
	gitLayoutProblem,
	isNetworkUrl,
	locateGit,
} from './git/native-host.js';
import type { Author } from './git/objects.js';
import type {
	HistoryReply,
	HistoryRequest,
	HistoryState,
} from './history-wire.js';

export {
	type CheckedTable,
	checkFolder,
	DECLARATION_SOURCE_PATH,
	type Finding,
	type FolderCheck,
	hasDeclarationSource,
} from './check-folder.js';
export * from './contract.js';
export {
	GenerateDeclarationError,
	generateDeclaration,
} from './generate-declaration.js';
export { basicAuthorization } from './git/http.js';
export { GitCommandError, type GitRun } from './git/native-backend.js';
export {
	createGitRunner,
	endGitCommands,
	GitMissingError,
	locateGit,
	runGit,
} from './git/native-host.js';
export {
	decodeHistory,
	encodeHistory,
	type GitMissingReply,
	type HistoryReply,
	type HistoryRequest,
	type HistoryResults,
	type HistoryState,
} from './history-wire.js';
export {
	type GitMerge,
	gitMergeKind,
	mergeForGit,
} from './merge-driver.js';
export {
	type QueryAnswer,
	QueryFolderError,
	queryFolder,
} from './query-folder.js';
export {
	type FolderReading,
	ReadFolderError,
	readFolder,
} from './read-folder.js';

export type DirectoryFolderOptions<TDefinition extends FolderDefinition> = {
	/** An existing directory. Opening creates nothing in it; its first commit creates its repository. */
	readonly root: string;
	readonly definition: TDefinition;
	readonly git: FolderGitOptions;
};

export type DataFolderOptions<
	TLens extends FolderDefinition = FolderDefinition,
> = {
	/** An existing directory. Opening creates nothing in it. */
	readonly root: string;
	readonly git: FolderGitOptions;
	/**
	 * The shape this caller reads, which the folder's declaration must
	 * contain (ADR-0538); see `OpenDataFolderOptions`.
	 */
	readonly lens?: TLens;
};

/**
 * Open the directory at `root`. Refusals are returned, not thrown: a
 * definition a folder cannot keep, a root that is not a directory, or one
 * whose `.git` is not a directory of its own (a `gitdir:` file or a link
 * points its history somewhere else).
 */
export async function openFolder<const TDefinition extends FolderDefinition>({
	root,
	definition,
	git,
}: DirectoryFolderOptions<TDefinition>): Promise<
	Result<Folder<TDefinition, TDefinition>, OpenFolderError>
> {
	const { data: resolved, error } = await directoryRoot(root);
	if (error !== null) return OpenFolderError.InvalidRoot(error);
	const opened = directory(resolved);
	return openDirectoryFolder({
		definition,
		...opened,
		history: systemHistory(resolved, opened.storage, git),
	});
}

/**
 * Open the existing directory at `root` with the schema in its own
 * `epicenter.json`, which the handle never writes (ADR-0535). A directory
 * without one opens with no tables; one that cannot be used is
 * `InvalidDeclaration`. The root is refused as `openFolder` refuses it.
 * With a `lens`, a declaration that does not contain it is `ShapeMismatch`,
 * and the handle's tables are the lens's (ADR-0538).
 *
 * Opening creates nothing. A directory with no repository reads as an empty
 * history with every file uncommitted, and its first commit creates the
 * repository, unless the directory is inside another repository's working
 * tree: that commit is `blocked`, and the files are committed with that
 * repository's Git (ADR-0517).
 */
export async function openDataFolder<
	const TLens extends FolderDefinition = FolderDefinition,
>({
	root,
	git,
	lens,
}: DataFolderOptions<TLens>): Promise<
	Result<Folder<TLens, FolderDefinition>, OpenFolderError>
> {
	const { data: resolved, error } = await directoryRoot(root);
	if (error !== null) return OpenFolderError.InvalidRoot(error);
	const opened = directory(resolved);
	return openDirectoryFolder<TLens, FolderDefinition, History>({
		definition: 'declared',
		lens,
		...opened,
		history: systemHistory(resolved, opened.storage, git, () =>
			enclosingRepository(resolved),
		),
	});
}

export type HistoryOptions = {
	/** Who commits where the folder's Git configuration names nobody. */
	readonly author: Author;
	/**
	 * An application's own folder, which may get a repository of its own
	 * inside another repository's working tree. A data folder may not: its
	 * first commit is blocked, and its files are committed with that
	 * repository's Git (ADR-0517).
	 */
	readonly application?: boolean;
	/**
	 * The credential for the remote a fetch or push names, asked for each
	 * transfer with the URL the folder's history reads.
	 */
	readonly credentials?: GitCredentials;
};

/**
 * Run one history operation, `request`, on the folder at `root` and answer
 * its reply: what the `epicenter` CLI runs for a desktop page (ADR-0559),
 * one process over the system `git` per `status`, `history`, `save-version`,
 * or `sync`. Throws when the folder cannot be used: not a directory, Git
 * state that would write elsewhere, a remote that is not a network URL, or
 * no `git` on this computer (`GitMissingError`).
 *
 * The folder is opened for its history alone: its file storage, its own
 * `epicenter.json` (rows merge as text when it has none), and history over
 * this process's `git` (`systemHistory`). An `epicenter.json` that is there
 * but cannot be read or prepared refuses a save version and a sync, which
 * could otherwise commit files its `local` keeps on this machine; status and
 * the log still read. A save version and a sync hold the folder's history
 * lock (`holdingHistoryLock`), so two processes never interleave them.
 * Reading status or the log takes no lock.
 */
export async function runHistory(
	root: string,
	request: HistoryRequest,
	{ author, application = false, credentials }: HistoryOptions,
): Promise<HistoryReply<unknown>> {
	const { data: resolved, error } = await directoryRoot(root);
	if (error !== null)
		throw new Error(
			`${root} cannot hold a folder: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
		);
	const layout = await gitLayoutProblem(resolved);
	if (layout !== undefined)
		throw new Error(`The folder at ${resolved} cannot be used: ${layout}.`);
	if (
		request.op === 'sync' &&
		request.connect !== undefined &&
		!isNetworkUrl(request.connect)
	)
		throw new Error(
			`${request.connect} is not a remote a folder syncs with: use an https:// or ssh:// URL, or http:// only to this computer`,
		);
	locateGit();

	const { storage: boundary } = directory(resolved);
	const { data: declared, error: declarationError } =
		await readDeclaration(boundary);
	// What stays local is read from `epicenter.json`, so a commit made without
	// it could carry those files (ADR-0577). Reading status and the log
	// commits nothing and proceeds; anything that commits is refused.
	if (
		declarationError !== null &&
		request.op !== 'status' &&
		request.op !== 'log'
	)
		throw new Error(
			`${resolved}/epicenter.json cannot be used, so nothing was committed: ${declarationError.reason}. Fix the file, or open the folder in its app to write it again.`,
		);
	const definition: FolderDefinition | undefined = declared ?? undefined;
	const landed: string[] = [];
	const open = await systemHistory(
		resolved,
		boundary,
		{
			author,
			credentials,
			// Status and the log record nothing, so they skip reading who
			// commits.
			commits: request.op !== 'status' && request.op !== 'log',
		},
		application ? undefined : () => enclosingRepository(resolved),
	)({
		landed: (paths) => landed.push(...paths),
	});
	const history = open(definition);
	try {
		const result = await (async (): Promise<unknown> => {
			switch (request.op) {
				case 'status':
					return history.status();
				case 'log':
					return history.log(request.depth);
				case 'saveVersion':
					return holdingHistoryLock(resolved, () =>
						history.commit({ message: request.message }),
					);
				case 'sync': {
					const options = {
						allowUnrelatedHistories: request.allowUnrelatedHistories,
					};
					const { connect } = request;
					return holdingHistoryLock(resolved, () =>
						connect === undefined
							? history.sync.run(options)
							: history.sync.connect(connect, options),
					);
				}
			}
		})();
		return {
			result,
			state: stateOf(history),
			landed: [...new Set(landed)].sort(),
		};
	} finally {
		await history.close();
	}
}

/** The history's state as a reply carries it. */
function stateOf(history: History): HistoryState {
	const { branch, remote, files, sync, lastCommit, lastPush } =
		history.snapshot;
	return {
		branch,
		remote,
		files: files.state === 'observed' ? files.value : undefined,
		sync: sync.state === 'observed' ? sync.value : undefined,
		lastCommit,
		lastPush,
	};
}

/**
 * The CLI's exit code for a reply (ADR-0558): 0 when the operation did what
 * it says, 1 when its result is a refusal or a finding a person acts on,
 * such as a sync that stopped.
 */
export function historyExitCode(reply: HistoryReply<unknown>): 0 | 1 {
	const { result } = reply;
	if (typeof result === 'object' && result !== null && 'error' in result)
		return (result as { error: unknown }).error === null ? 0 : 1;
	const status = (result as { status?: unknown } | null)?.status;
	return status === 'committed' || status === 'unchanged' ? 0 : 1;
}

/**
 * `root` with its links resolved, or why it cannot hold a folder: it is not
 * a directory, or its `.git` is not a directory of its own.
 */
export async function directoryRoot(
	root: string,
): Promise<Result<string, { root: string; cause: unknown }>> {
	try {
		const resolved = await realpath(root);
		if (!(await lstat(resolved)).isDirectory())
			throw new Error(`${root} is not a directory`);
		const dotGit = await lstat(join(resolved, '.git')).catch(() => undefined);
		if (dotGit !== undefined && !dotGit.isDirectory())
			throw new Error(`${root}/.git is not a directory of its own`);
		return Ok(resolved);
	} catch (cause) {
		return Err({ root, cause });
	}
}

/** This process's file system at `resolved`, and the folder's storage over it. */
function directory(resolved: string) {
	const files = savingPrimitives(resolved);
	return {
		rootPath: resolved,
		files,
		storage: createDirectoryStorage({
			root: resolved,
			primitives: files,
			// Sync's publish holds the save lock across its changes, which go
			// through `node:fs` itself meanwhile.
			hold: {
				lock: <T>(work: () => Promise<T>) => holdingSaveLock(resolved, work),
				held: nodeDirectoryPrimitives,
			},
		}),
	};
}

/** History over this process's own `git` at `resolved`. */
function systemHistory(
	resolved: string,
	boundary: LockingStorage,
	git: {
		readonly author: FolderGitOptions['author'];
		readonly credentials?: GitCredentials;
		/** Whether this history may commit; see `nativeHistory`. */
		readonly commits?: boolean;
	},
	initProblem?: () => Promise<string | undefined>,
) {
	return nativeHistory({
		rootPath: resolved,
		host: { run: createGitRunner(resolved), files: savingPrimitives(resolved) },
		boundary,
		author: git.author,
		credentials: git.credentials,
		initProblem,
		commits: git.commits,
	});
}

/**
 * `node:fs`, with each rename and removal, and the check of what it expects
 * just before it, under the directory's save lock (`holdingSaveLock`), as the
 * desktop shell makes each one under its publishing and save locks.
 */
function savingPrimitives(resolved: string): DirectoryPrimitives {
	return {
		...nodeDirectoryPrimitives,
		rename: (from, to, expected) =>
			holdingSaveLock(resolved, () =>
				nodeDirectoryPrimitives.rename(from, to, expected),
			),
		remove: (path, options) =>
			holdingSaveLock(resolved, () =>
				nodeDirectoryPrimitives.remove(path, options),
			),
	};
}

/** How long a save waits for another process's save to the same directory. */
const SAVE_LOCK_WAIT_MS = 10_000;

/**
 * Run `work`, one check and one change, holding the save lock of the
 * directory at `resolved`: an exclusive SQLite transaction on
 * `.<name>.epicenter-save-lock` beside it, which the desktop shell takes
 * around each checked rename and removal (`lock.rs` in
 * `tauri-plugin-epicenter-folder`). A save that cannot take the lock within
 * `SAVE_LOCK_WAIT_MS` throws before `work` runs, so it changed nothing.
 */
function holdingSaveLock<T>(
	resolved: string,
	work: () => Promise<T>,
): Promise<T> {
	return holdingFolderLock(resolved, 'save', SAVE_LOCK_WAIT_MS, work);
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
 * releases when the process ends, however it ends, so a killed holder
 * leaves nothing to recover. Bun has no `flock`, so this is the one
 * cross-process lock it can take without native code, and the desktop
 * shell takes the same kind (`lock.rs`). The folder's save and history
 * locks, the CLI's sign-in refresh, and its app installs all hold one.
 *
 * Work in this process takes turns first, so only one connection per lock
 * waits on the file lock, and it waits by polling with timers, never by
 * blocking the event loop. When another process still holds it after
 * `waitMs` (at once, for `0`), it throws `held` before `work` runs. A path
 * that is a link or not a regular file is refused, so the lock is never
 * taken on a database somewhere else.
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
		const database = await takeFileLock(path, waitMs, held);
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

/** How long a history operation waits for another process's. */
const HISTORY_LOCK_WAIT_MS = 60_000;

/**
 * Run `work`, one whole history operation (a save version or a sync),
 * holding the history lock of the directory
 * at `resolved`: an exclusive SQLite transaction on
 * `.<name>.epicenter-history-lock` beside it, the mechanism of the save
 * lock, held by whichever process runs the operation (ADR-0559). Two
 * `epicenter` children, from two windows or a terminal, take turns, so a
 * commit never lands between a sync's checkpoint and its merge. It is apart
 * from the save lock, so a page's saves never wait on a sync's network.
 * Reading status or history takes no lock. Waits up to
 * `HISTORY_LOCK_WAIT_MS`, then throws before `work` runs.
 */
export function holdingHistoryLock<T>(
	resolved: string,
	work: () => Promise<T>,
): Promise<T> {
	return holdingFolderLock(resolved, 'history', HISTORY_LOCK_WAIT_MS, work);
}

/**
 * Why `resolved` may not get a repository of its own: a directory above it
 * holds `.git`, so it is inside that repository's working tree.
 */
async function enclosingRepository(
	resolved: string,
): Promise<string | undefined> {
	for (let at = dirname(resolved); ; at = dirname(at)) {
		if ((await lstat(join(at, '.git')).catch(() => undefined)) !== undefined)
			return `${resolved} is inside the repository at ${at}; commit it with that repository's Git`;
		if (dirname(at) === at) return undefined;
	}
}
