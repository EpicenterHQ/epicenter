/**
 * One history operation on a directory folder, as the `epicenter` CLI runs
 * it for a desktop page (ADR-0559): `status`, `history`, `save-version`, and
 * `sync`, each one process over the system `git`.
 *
 * The folder is opened for its history alone: its file storage, its own
 * `epicenter.json` (rows merge as text when it has none, or one that does not
 * read), and history over this process's `git` (`systemHistory`). A save
 * version and a sync, and the settling of a sync's attempt, hold the folder's
 * history lock (`holdingHistoryLock`), so two processes never interleave
 * them. Reading status or the log takes no lock.
 *
 * A sync that needs choices records its attempt under `.git/epicenter`
 * (`attemptFile`), and `settle` names it by ID with the person's choices:
 * the conflicts are merged again from the recorded commits, never read back
 * from the caller.
 */

import {
	directory,
	directoryRoot,
	enclosingRepository,
	holdingHistoryLock,
	systemHistory,
} from './bun.js';
import { readDeclaration } from './declaration.js';
import type { FolderDefinition } from './definition.js';
import type { History } from './git/history.js';
import type { GitCredentials } from './git/http.js';
import {
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
import { createOpfsFileBoundary } from './opfs-store.js';

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
 * Run `request` on the folder at `root` and answer its reply. Throws when
 * the folder cannot be used: not a directory, Git state that would write
 * elsewhere, a remote that is not a network URL, or no `git` on this
 * computer (`GitMissingError`).
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

	const { root: handle, locks } = directory(resolved);
	const boundary = createOpfsFileBoundary({
		root: handle,
		locks,
		filesLock: `epicenter-folder-directory-files:${JSON.stringify(['directory', resolved])}`,
		landed: () => {},
	});
	const { data: declared } = await readDeclaration(boundary);
	const definition: FolderDefinition | undefined = declared ?? undefined;
	const landed: string[] = [];
	const open = await systemHistory(
		resolved,
		{
			author,
			credentials,
			// Status and the log record nothing, so they skip reading who
			// commits.
			commits: request.op !== 'status' && request.op !== 'log',
		},
		application ? undefined : () => enclosingRepository(resolved),
	)({
		boundary,
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
				case 'settle':
					return holdingHistoryLock(resolved, () =>
						history.sync.resolve(
							{ id: request.attempt },
							request.choices as never,
						),
					);
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

/**
 * The CLI's exit code for a reply (ADR-0558): 0 when the operation did what
 * it says, 1 when its result is a refusal or a finding a person acts on,
 * such as a sync that needs choices.
 */
export function historyExitCode(reply: HistoryReply<unknown>): 0 | 1 {
	const { result } = reply;
	if (typeof result === 'object' && result !== null && 'error' in result)
		return (result as { error: unknown }).error === null ? 0 : 1;
	const status = (result as { status?: unknown } | null)?.status;
	return status === 'committed' || status === 'unchanged' ? 0 : 1;
}
