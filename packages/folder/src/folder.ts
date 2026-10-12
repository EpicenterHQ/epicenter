/**
 * The opened folder handle every opener returns (ADR-0471, ADR-0478).
 *
 * `tables`, `kv`, and `files` publish through one file boundary, one file
 * change per operation. A caller that needs several changes makes several
 * calls; each one that succeeded stays published when a later one fails.
 * `git` observes and records history. A complete content save requests an
 * automatic commit when the folder's history policy says so. Requests made
 * before a checkpoint starts share that checkpoint.
 *
 * Closing fences new file work and this handle's history requests at once.
 * Browser and Bun handles cancel pending history and network work, then drain
 * admitted Git work. A desktop handle detaches its page; the shared native
 * owner continues until owner shutdown cancels pending work and drains
 * admitted checkpoints. Each file operation owns its completion promise.
 * Closing does not wait for file helpers; storage applications already started
 * return their actual outcome. Closing makes no last commit.
 */
import type { CreateRowOf, KvOf } from '@epicenter/definition';
import type { Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import type { FolderDefinition, PreparedFolderTable } from './definition.js';
import { createFiles, type FolderFiles } from './files.js';
import type { GitRemote, PathStatus } from './git/backend.js';
import type { SyncError } from './git/errors.js';
import type {
	CommitAndPushResult,
	CommitOutcome,
	FetchOutcome,
	FilesObservation,
	GitError,
	GitSnapshot,
	MergeConflictPolicy,
	MergeError,
	MergeOutcome,
	PullError,
	PullOutcome,
	PushOutcome,
	RecoverOutcome,
} from './git/history.js';
import type { Author, CommitSummary } from './git/objects.js';
import type { SyncAttempt, SyncChoices, SyncOutcome } from './git/sync.js';
import { createKv, type FileKv } from './kv.js';
import { callObserver } from './observer.js';
import { fenceStorage } from './storage.js';
import { createTable, type FileTable } from './table.js';
import type { FolderTerminal } from './terminal.js';

/** History settings for a folder whose history this process records. */
export type FolderGitOptions = {
	/** Author and committer for automatic commits. */
	readonly author: Author;
	/** The remote branch to push to and fetch from. */
	readonly remote?: GitRemote;
};

export type FolderGit = {
	readonly snapshot: GitSnapshot;
	/** Delivers the current snapshot synchronously, then each change. */
	subscribe(listener: (snapshot: GitSnapshot) => void): () => void;
	/** A fresh inspection of uncommitted changes and local/remote heads. */
	status(): Promise<Result<FilesObservation, GitError>>;
	/**
	 * Commit current source files if they changed, and reset the index to the
	 * head either way. Never pushes.
	 */
	commit(): Promise<CommitOutcome>;
	/**
	 * Commit, then push. `signal` only stops this caller waiting
	 * (`stoppedWaiting`): a commit or transport that already started keeps
	 * running. Closing a browser or directory folder aborts owned network
	 * work. Closing a desktop handle stops this page waiting; a transport the
	 * native owner already started finishes there. A push or fetch withdrawn
	 * before it starts never starts. The same holds for `push` and `fetch`.
	 */
	commitAndPush(options?: {
		signal?: AbortSignal;
	}): Promise<CommitAndPushResult>;
	push(options?: { signal?: AbortSignal }): Promise<PushOutcome>;
	fetch(options?: {
		signal?: AbortSignal;
	}): Promise<Result<FetchOutcome, GitError>>;
	/** Apply the fetched remote head only as a clean fast-forward. */
	pullFastForward(): Promise<Result<PullOutcome, PullError | GitError>>;
	/**
	 * Merge the fetched remote head into a clean folder: a fast-forward when
	 * possible, otherwise one commit with the branch head and the fetched head
	 * as parents. Root `kv.json` merges by key; other files by Git's rules.
	 * A refusal or a conflict changes no file, index entry, or ref; `sync`
	 * is how a person settles a conflict. Never pushes. Browser, directory,
	 * and desktop folders all merge.
	 */
	mergeIncoming(
		options?: MergeConflictPolicy,
	): Promise<Result<MergeOutcome, MergeError | PullError | GitError>>;
	/**
	 * Finish or clear the incoming update in `snapshot.pendingIncoming`, only
	 * because it is asked for. An `unadmitted` (empty) record is removed:
	 * `admissionCleared`. A branch already at the published commit is cleared
	 * without writing a file: `cleared`. Over the admitted head, each changed
	 * path at its before state is written and each at its after state is left,
	 * removals first, then the index and the branch: `completed`. A path, the
	 * index, the branch, or an unreadable record in neither state is
	 * `RecoveryRefused`, names it, and writes nothing; the update stays
	 * pending. A step whose outcome is unknown is `Unconfirmed` and leaves it
	 * pending too. Status is observed again afterward, never assumed clean.
	 * Nothing retries. Browser and desktop folders retain their own incoming
	 * record and evaluate current paths again on each explicit recovery.
	 */
	recoverIncoming(): Promise<Result<RecoverOutcome, PullError | GitError>>;
	/** Per-path staged and unstaged state, as `git status` reports it. */
	paths(): Promise<Result<PathStatus[], GitError>>;
	/** Unstaged changes of `paths`, every path when empty, as `git diff` shows them. */
	diff(paths: readonly string[]): Promise<Result<string, GitError>>;
	log(depth: number): Promise<Result<CommitSummary[], GitError>>;
};

/**
 * Synchronization with the configured remote branch (ADR-0514): `run()`,
 * then, when it needs choices, `resolve(attempt, choices)` on this same
 * folder.
 *
 * ```ts
 * const { data: ran, error } = await folder.sync.run();
 * if (error !== null) return show(error.message);
 * if (ran.kind === 'needsChoices') {
 *   // Usually from the shared review (`@epicenter/svelte/sync-review`).
 *   const choices = { [ran.conflicts[0].id]: { kind: 'take', side: 'incoming' } };
 *   const { data: done, error: resolveError } = await folder.sync.resolve(ran, choices);
 * }
 * ```
 *
 * Browser and directory folders implement it. A desktop folder answers
 * `Unsupported` from both methods.
 */
export type FolderSync = {
	/**
	 * Whether this folder's runtime syncs. False for a desktop folder, whose
	 * `run` and `resolve` answer `Unsupported`; an app offers its separate
	 * Git actions there instead.
	 */
	readonly supported: boolean;
	/**
	 * Commit saved files, fetch the remote branch, merge it, and push.
	 * One-sided and compatible changes need no choices. Root `kv.json` merges
	 * by key, each row of a declared table by field and body, written in the
	 * standard form, and any other text file by line. Competing settings,
	 * fields, bodies, and whole text files (deleted on one side, unreadable as
	 * a row, or with competing lines) return `needsChoices`; nothing
	 * conflicted is written and nothing is sent. Binary files and file
	 * against directory are `Unreviewable`. A run retires the attempt before
	 * it.
	 */
	run(): Promise<Result<SyncOutcome | SyncAttempt, SyncError>>;
	/**
	 * Settle this folder's current attempt with one choice per conflict,
	 * without fetching again. The choices are read before this returns.
	 * Invalid choices are `InvalidChoices`, writing nothing and keeping the
	 * attempt current. Otherwise the attempt is spent: the folder must still
	 * be at the captured head with no saved change since (`Stale` if not),
	 * the merge of the captured commits is published like an incoming merge,
	 * and the result is pushed without force.
	 */
	resolve(
		attempt: SyncAttempt,
		choices: SyncChoices,
	): Promise<Result<SyncOutcome, SyncError>>;
};

/** Borrowed data access; the object that opened the folder owns its lifetime. */
export type FolderAccess<TDefinition extends FolderDefinition> = {
	readonly tables: {
		readonly [K in keyof TDefinition['tables']]: FileTable<
			CreateRowOf<TDefinition['tables'][K]>
		>;
	};
	readonly kv: FileKv<KvOf<TDefinition>>;
	readonly files: FolderFiles;
	readonly git: FolderGit;
};

/**
 * Where an opened folder's files are. For showing to a person or telling
 * folders apart; file paths passed to the folder are never joined onto it.
 */
export type FolderLocation =
	/** A directory of this origin's private file system, by its path from the root. */
	| { readonly kind: 'opfs'; readonly directory: string }
	/** An ordinary directory, by absolute path. */
	| { readonly kind: 'directory'; readonly root: string };

export type Folder<TDefinition extends FolderDefinition> =
	FolderAccess<TDefinition> & {
		readonly location: FolderLocation;
		readonly sync: FolderSync;
		/**
		 * Hear that files changed, as a hint to read again. The paths are the
		 * ones a change reached. There is not one call per save, calls are not
		 * ordered against other folders' saves, and a hint is never a capture.
		 * Subscribe before the first read so no change falls between them.
		 * Returns the function that stops listening; closing stops all of them.
		 */
		onFilesChanged(listener: (paths: readonly string[]) => void): () => void;
		/**
		 * A shell over this folder's files and history. A redirection is a
		 * deliberate overwrite; a rewrite of a file the same command read is
		 * conditional on what it read. The terminal ends with the folder.
		 */
		terminal(options?: { cwd?: string }): FolderTerminal;
		/** Aborts when closing starts. */
		readonly signal: AbortSignal;
		/**
		 * Fence the next storage call and drain owned Git work before release.
		 * Await each file operation that must finish before closing; close does
		 * not wait for file helpers or their publication replies.
		 */
		close(): Promise<void>;
	};

/** The history observations and requests the handle exposes. */
export type FolderHistory = FolderGit & {
	readonly sync: FolderSync;
	close(): Promise<void>;
};

/** File-change hints for one opened folder. */
export type FileHints = {
	/** A change this handle made: tell listeners, and whoever relays it onward. */
	emit(paths: readonly string[]): void;
	/** A change reported from elsewhere: tell listeners only. */
	receive(paths: readonly string[]): void;
	subscribe(listener: (paths: readonly string[]) => void): () => void;
	/** Stop calling this handle's listeners and drop them. Relaying continues. */
	close(): void;
};

/** `relay` carries this handle's own changes to other handles on the same files. */
export function createFileHints(
	relay?: (paths: readonly string[]) => void,
): FileHints {
	const listeners = new Set<(paths: readonly string[]) => void>();
	let closed = false;
	function receive(paths: readonly string[]) {
		// A listener may close the folder or stop another listener. The ones
		// after it are asked again before each call, so neither hears a hint it
		// was fenced from, and one that throws does not silence the rest.
		for (const listener of [...listeners]) {
			if (closed) return;
			if (listeners.has(listener))
				callObserver('change listener', listener, paths);
		}
	}
	return {
		emit(paths) {
			if (paths.length === 0) return;
			receive(paths);
			// A save that finishes while this handle closes still changed the
			// files other handles are looking at. A relay that fails is that
			// handle's missed hint, never this save's failure.
			if (relay !== undefined) callObserver('change relay', relay, paths);
		},
		receive(paths) {
			if (paths.length > 0) receive(paths);
		},
		subscribe(listener) {
			if (closed) return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close() {
			closed = true;
			listeners.clear();
		},
	};
}

function createFolderGit(history: FolderHistory): FolderGit {
	return Object.freeze({
		get snapshot() {
			return history.snapshot;
		},
		subscribe: (listener) => history.subscribe(listener),
		status: () => history.status(),
		commit: () => history.commit(),
		commitAndPush: (options) => history.commitAndPush(options),
		push: (options) => history.push(options),
		fetch: (options) => history.fetch(options),
		pullFastForward: () => history.pullFastForward(),
		mergeIncoming: (options) => history.mergeIncoming(options),
		recoverIncoming: () => history.recoverIncoming(),
		paths: () => history.paths(),
		diff: (paths) => history.diff(paths),
		log: (depth) => history.log(depth),
	} satisfies FolderGit);
}

/** Load one terminal per caller; the terminal owns command ordering. */
function createLocalTerminal(
	{
		storage,
		git,
		signal,
	}: { storage: FolderStorage; git: FolderGit; signal: AbortSignal },
	{ cwd = '/' }: { cwd?: string } = {},
): FolderTerminal {
	let terminal: FolderTerminal | undefined;
	let loading: Promise<FolderTerminal> | undefined;
	return {
		get cwd() {
			return terminal?.cwd ?? cwd;
		},
		async exec(command, options) {
			if (signal.aborted)
				return { stdout: '', stderr: 'The folder is closed\n', exitCode: 1 };
			loading ??= import('./terminal.js').then(({ createTerminal }) => {
				terminal = createTerminal({ storage, git }, { cwd });
				return terminal;
			});
			const loaded = await loading;
			return loaded.exec(command, {
				signal:
					options?.signal === undefined
						? signal
						: AbortSignal.any([signal, options.signal]),
			});
		},
	};
}

/**
 * Assemble the handle over acquired storage. `prepared` is the opener's
 * `prepareFolderDefinition` result, taken before it acquired anything: the
 * snapshot every table and the KV read through, never the declaration the
 * opener was handed. No argument carries `TDefinition`, so the opener names
 * it.
 */
export function assembleFolder<TDefinition extends FolderDefinition>({
	prepared,
	storage: suppliedStorage,
	history,
	location,
	hints,
	release,
}: {
	prepared: FolderDefinition;
	storage: FolderStorage;
	history: FolderHistory;
	location: FolderLocation;
	hints: FileHints;
	/** Releases this attachment after owned Git work settles. */
	release: () => Promise<void>;
}): Folder<TDefinition> {
	const controller = new AbortController();
	let closing: Promise<void> | undefined;

	const storage = fenceStorage(suppliedStorage, controller.signal);
	const tables: Record<string, FileTable<unknown>> = {};
	// A table's key is its name and its directory.
	// The opener prepared every table, which is what the type's mark records.
	for (const [name, table] of Object.entries(prepared.tables))
		tables[name] = createTable<unknown>(
			{ storage },
			name,
			table as PreparedFolderTable,
		);
	const files = createFiles({ storage });
	const git = createFolderGit(history);

	return Object.freeze({
		tables: Object.freeze(tables) as Folder<TDefinition>['tables'],
		kv: createKv({ storage }, prepared.kv) as Folder<TDefinition>['kv'],
		files,
		git,
		location: Object.freeze(location),
		sync: history.sync,
		onFilesChanged: (listener: (paths: readonly string[]) => void) =>
			hints.subscribe(listener),
		terminal: (options) =>
			createLocalTerminal({ storage, git, signal: controller.signal }, options),
		signal: controller.signal,
		close() {
			if (closing !== undefined) return closing;
			const completion = Promise.withResolvers<void>();
			// Abort and history observers may call close again synchronously.
			// Give them this completion before notifying either one.
			closing = completion.promise;
			void (async () => {
				// Fence new file work and hints, then close this handle's history.
				controller.abort();
				hints.close();
				await history.close();
				await release();
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	} satisfies Folder<TDefinition>);
}
