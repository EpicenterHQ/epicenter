/**
 * `@epicenter/folder/bun`: open an ordinary directory as a `Folder`, in Bun,
 * and the `epicenter` CLI's tools over a directory.
 *
 * `openFolder({ directory, tables })` opens an existing directory
 * (`native/bun.ts`): this process reaches the disk itself, with `node:fs`,
 * and each save takes the directory's save lock, the one the desktop shell
 * and other Bun processes take (ADR-0562). Git is optional and not on the
 * handle's lifetime (ADR-0636).
 *
 * The rest is what the CLI runs over a directory it is given (ADR-0520):
 * `checkFolder`, `queryFolder`, and `readFolder` read the root
 * `epicenter.json` (ADR-0632), whose grammar `defineFolder`,
 * `formatDefinition`, and `parseDefinition` write and read; `runHistory`
 * runs one history operation over the system `git` (ADR-0559); and the Git
 * and lock helpers its other commands share. None of them opens a `Folder`.
 */

import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { LockingStorage } from './boundary.js';
import { readDefinition } from './declaration.js';
import type { Definition } from './definition.js';
import { nodeDirectoryPrimitives } from './directory-node.js';
import type { DirectoryPrimitives } from './directory-primitives.js';
import { createDirectoryStorage } from './directory-store.js';
import type { FolderHistory } from './git/history.js';
import type { GitCredentials } from './git/http.js';
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
import { holdingHistoryLock, holdingSaveLock } from './native/directory.js';

export { type CreateRowOf, defineTable, field } from '@epicenter/definition';
export {
	type CheckedTable,
	checkFolder,
	DEFINITION_SOURCE_PATH,
	type Finding,
	type FolderCheck,
	hasDefinitionSource,
} from './check-folder.js';
export * from './contract.js';
export { formatDefinition, parseDefinition } from './declaration.js';
export { type Definition, defineFolder } from './definition.js';
export { nodeDirectoryPrimitives } from './directory-node.js';
export {
	GenerateDefinitionError,
	generateDefinition,
} from './generate-declaration.js';
export { basicAuthorization, type GitCredentials } from './git/http.js';
export { GitCommandError, type GitRun } from './git/native-backend.js';
export {
	createGitRunner,
	endGitCommands,
	GitMissingError,
	locateGit,
	runGit,
} from './git/native-host.js';
export {
	NEUTRAL_ATTRIBUTES,
	neutralizeAttributes,
} from './git/neutral-attributes.js';
export {
	encodeHistory,
	type GitMissingReply,
	type HistoryReply,
	type HistoryRequest,
	type HistoryResults,
	type HistoryState,
} from './history-wire.js';
export { openBunFolder as openFolder } from './native/bun.js';
export { holdingFileLock, holdingHistoryLock } from './native/directory.js';
export { DEFINITION_PATH } from './paths.js';
export { describeTables } from './projection.js';
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
	 * The `local` patterns of an app reading a folder that is not its own
	 * (ADR-0583): an untracked file they match is never committed, and the
	 * folder's `epicenter.json` is not changed.
	 */
	readonly appLocal?: readonly string[];
	/**
	 * The credential for the remote a fetch or push names, asked for each
	 * transfer with the URL the folder's history reads.
	 */
	readonly credentials?: GitCredentials;
};

/**
 * Run one history operation, `request`, on the folder at `root` and answer
 * its reply: what the `epicenter` CLI runs, one process over the system
 * `git` per `status`, `history`, `save-version`, or `sync` (ADR-0559).
 * Throws when the folder cannot be used: not a directory, Git state that
 * would write elsewhere, a remote that is not a network URL, or no `git` on
 * this computer (`GitMissingError`).
 *
 * The folder's history is opened for this one operation: its file storage,
 * its own `epicenter.json` (rows merge as text when it has none), and history
 * over this process's `git` (`systemHistory`). An `epicenter.json` that is
 * there but cannot be read or prepared refuses a save version and a sync,
 * which could otherwise commit files its `local` keeps on this machine;
 * status and the log still read. A save version and a sync hold the folder's
 * history lock (`holdingHistoryLock`), so two processes never interleave
 * them. Reading status or the log takes no lock.
 */
export async function runHistory(
	root: string,
	request: HistoryRequest,
	{ author, application = false, appLocal, credentials }: HistoryOptions,
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

	const boundary = directoryStorage(resolved);
	const { data: declared, error: declarationError } =
		await readDefinition(boundary);
	// What stays local is read from `epicenter.json`, so a commit made without
	// it could carry those files (ADR-0577). Reading status and the log
	// commits nothing and proceeds; anything that commits is refused.
	if (
		declarationError !== null &&
		request.op !== 'status' &&
		request.op !== 'log'
	)
		throw new Error(
			`${resolved}/epicenter.json cannot be used, so nothing was committed: ${declarationError.reason}. Fix the file, then try again.`,
		);
	const definition: Definition | undefined = declared ?? undefined;
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
	const history = open(definition, appLocal);
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
function stateOf(history: FolderHistory): HistoryState {
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
 * `root` with its links resolved, or why its history cannot be run: it is not
 * a directory, or its `.git` is not a directory of its own.
 */
async function directoryRoot(
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

/**
 * The directory's storage over this process's file system at `resolved`, as
 * Sync publishes through it: each change under the save lock, and `lock`
 * holding it across several, which then go through `node:fs` itself.
 */
function directoryStorage(resolved: string): LockingStorage {
	return createDirectoryStorage({
		root: resolved,
		primitives: savingPrimitives(resolved),
		hold: {
			lock: <T>(work: () => Promise<T>) => holdingSaveLock(resolved, work),
			held: nodeDirectoryPrimitives,
		},
	});
}

/** History over this process's own `git` at `resolved`. */
function systemHistory(
	resolved: string,
	boundary: LockingStorage,
	git: {
		readonly author: Author;
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
 * just before it, under the directory's save lock, as the desktop shell
 * makes each one under its publishing and save locks.
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
