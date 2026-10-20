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
 * `formatDefinition`, and `readDeclaredTables` write and read; `runHistory`
 * runs one history operation over the system `git` (ADR-0559); and the Git
 * and lock helpers its other commands share. None of them opens a `Folder`.
 */

import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { sweepStaleScratch } from './directory-store.js';
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
import { holdingHistoryLock, scratchDirectory } from './native/directory.js';
import { nativeStorage, savingPrimitives } from './native/storage.js';

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
export {
	formatDefinition,
	parseDeclaration,
	parseDeclarationObject,
} from './declaration.js';
export {
	type Declaration,
	DeclarationSchema,
	type PortableTableSchema,
	validateTableSchema,
} from './declaration-schema.js';
export { type Definition, defineFolder } from './definition.js';
export { readDirectoryDocuments } from './directory-documents.js';
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
export {
	exportFolderSchemas,
	importFolderSchemas,
} from './native/declaration.js';
export { holdingFileLock, holdingHistoryLock } from './native/directory.js';
export { DEFINITION_PATH } from './paths.js';
export { describeTables } from './projection.js';
export { queryDocuments } from './query-documents.js';
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
export { exportTables } from './schema-export.js';

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
 * its reply: what the `epicenter` CLI runs, one process over the system
 * `git` per `status`, `history`, `save-version`, or `sync` (ADR-0559).
 * Throws when the folder cannot be used: not a directory, Git state that
 * would write elsewhere, a remote that is not a network URL, or no `git` on
 * this computer (`GitMissingError`).
 *
 * The folder's history is opened for this one operation: its file storage,
 * which stages in `.<name>.epicenter-scratch` beside the folder as a Bun
 * folder does, using ordinary Git ignore and tracked-file rules. No schema
 * declaration is required. Saves never enter this history lifecycle.
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

	const commits = request.op !== 'status' && request.op !== 'log';
	const scratch = scratchDirectory(resolved);
	const boundary = nativeStorage(resolved);
	// What a stopped write staged an hour or more ago goes before anything
	// is staged, as at a Bun folder's open.
	if (commits) await sweepStaleScratch(scratch, savingPrimitives(resolved));
	const landed: string[] = [];
	const history = await nativeHistory({
		rootPath: resolved,
		host: { run: createGitRunner(resolved), files: savingPrimitives(resolved) },
		boundary,
		author,
		credentials,
		initProblem: application ? undefined : () => enclosingRepository(resolved),
		// Status and the log record nothing, so they skip reading who commits.
		commits,
		landed: (paths) => landed.push(...paths),
	});
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
