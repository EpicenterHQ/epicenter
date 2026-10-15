/**
 * The opened folder handle every opener returns (ADR-0471, ADR-0478).
 *
 * `tables`, `kv`, and `files` publish through one file boundary, one file
 * change per operation. A caller that needs several changes makes several
 * calls; each one that succeeded stays published when a later one fails.
 * `git` observes and records history. A save never commits: commits happen
 * only through `git.commit()` or sync's checkpoint (ADR-0529).
 *
 * Closing fences new file work and this handle's history requests at once,
 * cancels pending history and network work, then drains admitted Git work.
 * Each file operation owns its completion promise. Closing does not wait for
 * file helpers; storage applications already started return their actual
 * outcome. Closing makes no last commit.
 */
import {
	type CreateRowOf,
	type KvOf,
	requiredOutsideShape,
} from '@epicenter/definition';
import type { Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import type { FolderDefinition, PreparedFolderTable } from './definition.js';
import { createFiles, type FolderFiles } from './files.js';
import type { PathStatus } from './git/backend.js';
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
	StagedCommit,
} from './git/history.js';
import type { GitCredentials } from './git/http.js';
import type { Author, CommitSummary } from './git/objects.js';
import type {
	SyncAttempt,
	SyncChoices,
	SyncOptions,
	SyncOutcome,
} from './git/sync.js';
import { createKv, type FileKv } from './kv.js';
import { callObserver } from './observer.js';
import { declaring } from './publish-definition.js';
import { fenceStorage } from './storage.js';
import { createTable, type FileTable } from './table.js';

/** History settings for a folder whose history this process records. */
export type FolderGitOptions = {
	/** Author and committer for the folder's commits. */
	readonly author: Author;
	/** Asked before each push and fetch; see `GitCredentials`. */
	readonly credentials?: GitCredentials;
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
	 * running. Closing the folder aborts its network work. A push or fetch
	 * withdrawn before it starts never starts. The same holds for `push` and
	 * `fetch`.
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
	 * is how a person settles a conflict. An update cut off partway is
	 * `Interrupted`: the files it wrote show as changes, and the next sync
	 * records them and merges again. Never pushes. Browser, directory, and
	 * desktop folders all merge.
	 */
	mergeIncoming(
		options?: MergeConflictPolicy,
	): Promise<Result<MergeOutcome, MergeError | PullError | GitError>>;
	/** Per-path staged and unstaged state, as `git status` reports it. */
	paths(): Promise<Result<PathStatus[], GitError>>;
	/** Stage paths for a commit authored with `commitStaged`. */
	stage(paths: readonly string[] | 'all'): Promise<Result<undefined, GitError>>;
	/**
	 * Commit staged changes with a user-authored message in manual mode. The
	 * commit pins its parent and moves the branch only if it still names that
	 * parent; otherwise it is `BranchMoved` and keeps the index unchanged.
	 * Built-in commits run no commit hooks and are unsigned.
	 */
	commitStaged(message: string): Promise<Result<StagedCommit, GitError>>;
	diff(options: {
		staged: boolean;
		paths: readonly string[];
	}): Promise<Result<string, GitError>>;
	log(depth: number): Promise<Result<CommitSummary[], GitError>>;
};

/**
 * Synchronization with the configured remote branch (ADR-0514): `run()`,
 * then, when it needs choices, `resolve(attempt, choices)` on this same
 * folder.
 *
 * ```ts
 * const { data: done, error } = await folder.sync.run();
 * if (error?.name === 'NeedsChoices') {
 *   // Usually from the shared review (`@epicenter/svelte/sync-review`).
 *   const { attempt } = error;
 *   const choices = { [attempt.conflicts[0].id]: { kind: 'take', side: 'incoming' } };
 *   const resolved = await folder.sync.resolve(attempt, choices);
 * }
 * ```
 *
 * Browser and directory folders implement it, the desktop folder included.
 */
export type FolderSync = {
	/**
	 * Commit saved files, fetch the remote branch, merge it, and push.
	 * One-sided and compatible changes need no choices. Root `kv.json` merges
	 * by key, each row of a declared table by field and body, written in the
	 * standard form, and any other text file by line. Competing settings,
	 * fields, bodies, and whole text files (deleted on one side, unreadable as
	 * a row, or with competing lines) are `NeedsChoices`; nothing
	 * conflicted is written and nothing is sent. Binary files and file
	 * against directory are `Unreviewable`. A run retires the attempt before
	 * it.
	 */
	run(options?: SyncOptions): Promise<Result<SyncOutcome, SyncError>>;
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
	/**
	 * Make `url` the folder's remote (`remote.origin.url` in its Git
	 * configuration), then sync. This is how a folder gets a remote, or
	 * changes it. An empty folder takes the remote's history; a folder with
	 * files and no history of its own merges them with it; a remote with no
	 * branch receives this folder's. Separate histories are `Unrelated` until
	 * `allowUnrelatedHistories` combines them. The remote stays set whatever
	 * the sync answers, and a later `run` continues.
	 */
	connect(
		url: string,
		options?: SyncOptions,
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

/**
 * An opened folder. `TDefinition` types `tables` and `kv`; `TDeclared` types
 * `definition`, and differs from it only for a lens, whose tables are typed by
 * the lens while the handle reads and writes with the folder's own
 * declaration.
 */
export type Folder<
	TDefinition extends FolderDefinition,
	TDeclared extends FolderDefinition = TDefinition,
> = FolderAccess<TDefinition> & {
	/**
	 * The prepared definition this handle reads with: the one `openFolder`
	 * was given, or the folder's own `epicenter.json` as `openDataFolder`
	 * read it when it opened (no tables and no settings when there was
	 * none), lens or not. Every row and setting is checked against it, and
	 * Sync merges rows by it. A declaration changed after opening is read
	 * by the next open.
	 */
	readonly definition: TDeclared;
	readonly location: FolderLocation;
	readonly sync: FolderSync;
	/**
	 * Hear that files may have changed, as a reason to read again (ADR-0548).
	 * `change` is the paths a change reached, or `'everything'` when the
	 * reporter cannot say which. A call carries no content and is never a
	 * capture; read through the folder to learn what the files hold.
	 *
	 * Reports come from the host's one detector of changes made outside
	 * this handle, and from incoming updates this handle's own Sync wrote.
	 * In a browser the detector is other pages of this origin, which tell
	 * the paths they write; on the desktop it is the shell's watcher of the
	 * granted directory; in Bun there is none. This handle's own saves are
	 * not reported: whoever saved holds the result.
	 *
	 * Nothing records reports, so one missed costs a delay, never data.
	 * Subscribe before the first read so no change falls between them.
	 * Returns the function that stops listening; closing stops all of them.
	 */
	onFilesChanged(listener: (change: FilesChanged) => void): () => void;
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

/** Which files changed: their paths, or `'everything'` when a report cannot say. */
export type FilesChanged = readonly string[] | 'everything';

/** Reports of file changes for one opened folder. */
export type FileHints = {
	/** Files changed: tell every listener. An empty list is no change. */
	report(change: FilesChanged): void;
	subscribe(listener: (change: FilesChanged) => void): () => void;
	/** Stop calling this handle's listeners and drop them. */
	close(): void;
};

export function createFileHints(): FileHints {
	const listeners = new Set<(change: FilesChanged) => void>();
	let closed = false;
	return {
		report(change) {
			if (change !== 'everything' && change.length === 0) return;
			const reported =
				change === 'everything' ? change : Object.freeze([...change]);
			// A listener may close the folder or stop another listener. The ones
			// after it are asked again before each call, so neither hears a
			// report it was fenced from, and one that throws does not silence
			// the rest.
			for (const listener of [...listeners]) {
				if (closed) return;
				if (listeners.has(listener))
					callObserver('change listener', listener, reported);
			}
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
		paths: () => history.paths(),
		stage: (paths) => history.stage(paths),
		commitStaged: (message) => history.commitStaged(message),
		diff: (options) => history.diff(options),
		log: (depth) => history.log(depth),
	} satisfies FolderGit);
}

/**
 * Assemble the handle over acquired storage. `prepared` is the prepared
 * definition: `openFolder`'s `prepareFolderDefinition` result, or the
 * declaration `openDataFolder` read. It is the snapshot every table and the
 * KV read through, never the declaration the opener was handed. No argument
 * carries `TDefinition`, so the opener names it.
 *
 * With a `lens` that `prepared` contains, the handle has the lens's tables
 * alone, each still reading and writing through `prepared`'s table, so a row
 * is checked against every field the folder declares and keeps the fields
 * the lens does not name.
 */
export function assembleFolder<
	TDefinition extends FolderDefinition,
	TDeclared extends FolderDefinition = TDefinition,
>({
	prepared,
	lens,
	publishes,
	storage: suppliedStorage,
	history,
	location,
	hints,
	release,
}: {
	prepared: FolderDefinition;
	/** The shape the caller reads, contained by `prepared` (ADR-0538). */
	lens?: FolderDefinition;
	/**
	 * Whether the handle publishes `prepared` to `epicenter.json` before its
	 * first write. `openFolder`'s handles do; `openDataFolder`'s, whose
	 * definition is that file, never write it.
	 */
	publishes: boolean;
	storage: FolderStorage;
	history: FolderHistory;
	location: FolderLocation;
	hints: FileHints;
	/** Releases this attachment after owned Git work settles. */
	release: () => Promise<void>;
}): Folder<TDefinition, TDeclared> {
	const controller = new AbortController();
	let closing: Promise<void> | undefined;

	const storage = fenceStorage(
		publishes ? declaring(suppliedStorage, prepared) : suppliedStorage,
		controller.signal,
	);
	const tables: Record<string, FileTable<unknown>> = {};
	// A table's key is its name and its directory.
	// The opener prepared every table, which is what the type's mark records.
	for (const name of Object.keys((lens ?? prepared).tables)) {
		const table = prepared.tables[name] as PreparedFolderTable;
		const shape = lens?.tables[name];
		tables[name] = createTable<unknown>(
			{ storage },
			name,
			table,
			shape === undefined
				? []
				: Object.freeze(requiredOutsideShape(table, shape)),
		);
	}
	const files = createFiles({ storage });
	const git = createFolderGit(history);

	return Object.freeze({
		definition: prepared as TDeclared,
		tables: Object.freeze(tables) as Folder<TDefinition>['tables'],
		kv: createKv({ storage }, prepared.kv) as Folder<TDefinition>['kv'],
		files,
		git,
		location: Object.freeze(location),
		sync: history.sync,
		onFilesChanged: (listener: (change: FilesChanged) => void) =>
			hints.subscribe(listener),
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
	} satisfies Folder<TDefinition, TDeclared>);
}
