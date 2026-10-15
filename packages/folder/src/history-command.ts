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
import type { GitCredential } from './git/http.js';
import {
	GitMissingError,
	gitLayoutProblem,
	isNetworkUrl,
	locateGit,
} from './git/native-host.js';
import type { Author } from './git/objects.js';
import {
	decodeHistory,
	encodeHistory,
	type HistoryReply,
	type HistoryRequest,
	type HistoryState,
	type UrlCredential,
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
	/** The branch history is recorded on; `main` unless the shell names one. */
	readonly branch?: string;
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

/** The credential for `url`, only when the page gave one for that exact URL. */
const credentialFor =
	(credential: UrlCredential | undefined) =>
	async (url: string): Promise<GitCredential | undefined> =>
		credential !== undefined && credential.url === url
			? { username: credential.username, password: credential.password }
			: undefined;

/**
 * Run `request` on the folder at `root` and answer its reply. Throws when
 * the folder cannot be used: not a directory, Git state that would write
 * elsewhere, a remote that is not a network URL, or no `git` on this
 * computer (`GitMissingError`).
 */
export async function runHistory(
	root: string,
	request: HistoryRequest,
	{ author, application = false, branch }: HistoryOptions,
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
	const credential =
		request.op === 'sync' || request.op === 'settle'
			? request.credential
			: undefined;
	const open = await systemHistory(
		resolved,
		{
			author,
			branch,
			credentials: credentialFor(credential),
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

/** One history command of the Epicenter shell, with the arguments a page sends. */
export type ShellHistoryCommand =
	| { readonly command: 'status' }
	| { readonly command: 'history'; readonly depth: number }
	| { readonly command: 'save_version'; readonly message: string | null }
	| {
			readonly command: 'sync';
			readonly remote: string | null;
			readonly allowUnrelated: boolean;
			readonly credential: UrlCredential | null;
	  }
	| {
			readonly command: 'settle_sync';
			readonly attempt: string;
			/** The choices in the history encoding, as the page sends them. */
			readonly choices: string;
			readonly credential: UrlCredential | null;
	  };

/** The request a shell history command makes of the CLI. */
export function historyRequestOf(shell: ShellHistoryCommand): HistoryRequest {
	switch (shell.command) {
		case 'status':
			return { op: 'status' };
		case 'history':
			return { op: 'log', depth: shell.depth };
		case 'save_version':
			return { op: 'saveVersion', message: shell.message ?? undefined };
		case 'sync':
			return {
				op: 'sync',
				connect: shell.remote ?? undefined,
				allowUnrelatedHistories: shell.allowUnrelated,
				credential: shell.credential ?? undefined,
			};
		case 'settle_sync':
			return {
				op: 'settle',
				attempt: shell.attempt,
				choices: decodeHistory(shell.choices),
				credential: shell.credential ?? undefined,
			};
	}
}

/**
 * What the shell answers a page for `shell`, run in this process: the
 * `epicenter` child's exit code and reply line, as the CLI prints it. For
 * tests and stand-ins that have no shell; the desktop app runs the CLI.
 */
export async function answerShellHistory(
	root: string,
	shell: ShellHistoryCommand,
	options: HistoryOptions,
): Promise<{ code: number; reply: string | null; stderr: string }> {
	try {
		const reply = await runHistory(root, historyRequestOf(shell), options);
		return {
			code: historyExitCode(reply),
			reply: encodeHistory(reply),
			stderr: '',
		};
	} catch (cause) {
		if (cause instanceof GitMissingError)
			return {
				code: 2,
				reply: encodeHistory({
					error: 'GitMissing',
					message: cause.message,
					install: cause.install,
				}),
				stderr: cause.message,
			};
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			code: 2,
			reply: encodeHistory({ error: message }),
			stderr: message,
		};
	}
}
