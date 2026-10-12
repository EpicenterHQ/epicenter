/**
 * What the shared history coordinator needs from a folder's Git storage.
 *
 * The browser backend keeps objects, refs, and the index in the folder's
 * private `.git` in the origin private file system and uses isomorphic-git. The native backend writes objects with
 * isomorphic-git but leaves index and ref mutation to the real `git` CLI,
 * whose lock files other native Git processes respect.
 *
 * Backend methods throw on failure; the coordinator turns failures into
 * reported outcomes.
 */
import type { FileChange } from '../boundary.js';
import type { FileError, FileStep } from '../errors.js';
import type { DeclaredAttribute } from './attributes.js';
import type { CapturedIndex } from './captured-index.js';
import type { CommitSummary, ObjectAccess, TreeFile } from './objects.js';

export type StatusCode = ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

/** One path's staged (`index`) and unstaged (`worktree`) state, as `git status` reports it. */
export type PathStatus = {
	readonly path: string;
	readonly index: StatusCode;
	readonly worktree: StatusCode;
};

export type GitRemote = {
	readonly url: string;
	readonly branch: string;
};

export type CasResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly actual: string | undefined };

/**
 * An incoming fast-forward or merge, prepared against observed files and
 * refs. `nextHead` is the fetched commit or the merge commit; `changes` turn
 * the files of `expectedHead` into its tree.
 */
export type IncomingPlan = {
	readonly expectedHead: string | undefined;
	readonly nextHead: string;
	readonly changes: readonly FileChange[];
	readonly paths: readonly string[];
	/**
	 * What the folder held when the update was planned: the SHA-256 of every
	 * portable file, and the exact index bytes checked for cleanliness. The browser
	 * requires both unchanged under its publication locks before it writes. A
	 * folder on disk checks only each changed file's own condition, best effort.
	 */
	readonly baseline: {
		readonly files: ReadonlyMap<string, string>;
		readonly index: Uint8Array | undefined;
	};
};

export type PublishResult =
	| { readonly status: 'published' }
	/** Nothing was written. */
	| { readonly status: 'refused'; readonly error: FileError }
	/** Browser only: the index changed after it was observed. Nothing was written. */
	| { readonly status: 'indexChanged' }
	/** Nothing was written, or files and index were applied first: `filesApplied` says which. */
	| {
			readonly status: 'branchMoved';
			readonly actual: string | undefined;
			readonly filesApplied: boolean;
	  }
	/**
	 * The update stopped after some of it landed, and the step that failed
	 * certainly wrote nothing; the branch did not move. `applied` names the
	 * file steps that reached the folder. A browser keeps its incoming record
	 * until `recoverIncoming` is asked for.
	 */
	| {
			readonly status: 'partial';
			readonly applied: readonly FileStep[];
			readonly error: FileError;
	  }
	/** Files were applied; the index was not written; the branch did not move. */
	| { readonly status: 'indexFailed'; readonly error: string }
	/**
	 * A step's outcome is unknown: `uncertain` names the file, the index, or
	 * the branch that may or may not have been written. The browser's record
	 * remains, and only an explicit recovery decides what happened.
	 */
	| {
			readonly status: 'unconfirmed';
			readonly applied: readonly FileStep[];
			readonly uncertain: readonly string[];
			readonly error: string;
	  };

/**
 * An incoming update whose authored changes may have begun. Everything else
 * (changed paths, target bytes, target index) is derived from the trees of
 * `expectedHead` and `nextHead`.
 */
export type RecordedIncoming = {
	readonly state: 'recorded';
	readonly operationId: string;
	readonly branch: string;
	/** The branch head the update was admitted over; `undefined` for an empty history. */
	readonly expectedHead: string | undefined;
	/** The fetched commit, or the prepared merge commit. */
	readonly nextHead: string;
};

/**
 * What a browser folder's incoming record says. While there is one, commits
 * and new incoming updates wait for an explicit recovery.
 */
export type PendingIncoming =
	| RecordedIncoming
	/**
	 * The record file exists and is empty: its write never finished, so the
	 * update was never admitted and changed no authored file.
	 */
	| { readonly state: 'unadmitted' }
	/** The record holds bytes that are not a record. Nothing reads past it or removes it. */
	| { readonly state: 'unreadable'; readonly reason: string };

/** What an explicit recovery of a pending incoming update did. */
export type RecoverIncomingResult =
	| { readonly status: 'none' }
	/** An `unadmitted` record was removed; no authored file was written. */
	| { readonly status: 'admissionCleared' }
	/** The branch already named `nextHead`: the record was cleared and no file was written. */
	| { readonly status: 'cleared'; readonly pending: RecordedIncoming }
	/** Paths at their before state were written; the index and branch followed. */
	| {
			readonly status: 'completed';
			readonly pending: RecordedIncoming;
			readonly changedPaths: readonly string[];
	  }
	/** A path, the index, the branch, or the record is in neither state. Nothing was written. */
	| {
			readonly status: 'refused';
			readonly pending: PendingIncoming;
			readonly paths: readonly string[];
			readonly reason: string;
	  }
	/** Recovery stopped partway; the record remains. */
	| {
			readonly status: 'partial';
			readonly pending: RecordedIncoming;
			readonly applied: readonly FileStep[];
			readonly error: FileError;
	  }
	/** A step's outcome is unknown; the record remains. */
	| {
			readonly status: 'unconfirmed';
			readonly pending: RecordedIncoming;
			readonly applied: readonly FileStep[];
			readonly uncertain: readonly string[];
			readonly error: string;
	  };

export type GitBackend = {
	readonly branch: string;
	readonly remote: GitRemote | undefined;
	/** Run object work. The browser flushes new objects durably before returning. */
	withObjects<T>(work: (access: ObjectAccess) => Promise<T>): Promise<T>;
	/**
	 * Serialize this folder's index and branch work. Network work never runs
	 * inside. A `signal` that aborts while `work` is still waiting rejects with
	 * the signal's reason and `work` never runs; once `work` has started, the
	 * signal changes nothing.
	 */
	exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
	readBranch(): Promise<string | undefined>;
	readRemoteTracking(): Promise<string | undefined>;
	/** Move the branch only if it still names `expected`. */
	casBranch(expected: string | undefined, next: string): Promise<CasResult>;
	/**
	 * Why no commit or incoming update may run now, such as a detached
	 * `HEAD`, a rebase in progress, or a merge another Git program began
	 * (`MERGE_HEAD`). The folder never begins one; that merge is finished or
	 * abandoned with Git outside it.
	 */
	blocked(): Promise<string | undefined>;
	/**
	 * Why a whole-folder commit or fast-forward cannot represent this
	 * repository faithfully: every file is written as plain `100644` bytes
	 * with no attribute filters, so symbolic links, executables, submodules,
	 * nested Git data, and normalizing attributes are refused rather than
	 * silently rewritten. Unmerged index stages another Git program left are
	 * refused too: a checkpoint would reset them and record conflict markers
	 * as ordinary content.
	 */
	checkpointProblem(): Promise<string | undefined>;
	/**
	 * The first of `files` that `commit`'s own attribute files give a filter
	 * or a byte conversion, or `undefined` when every one is plain bytes.
	 * `files` is the commit's whole tree, so an attribute that selects a file
	 * the commit did not change is found too. Only the pinned commit decides:
	 * attributes of the files currently in the folder are not consulted.
	 */
	incomingAttribute(
		commit: string,
		files: ReadonlyMap<string, TreeFile>,
	): Promise<DeclaredAttribute | undefined>;
	/**
	 * Make every index entry match `commit`'s tree, including staged-only
	 * additions and deletions. Working files are not touched.
	 */
	reconcileIndex(commit: string): Promise<void>;
	/** Which untracked candidates `.gitignore` (and native excludes) ignore. */
	ignoredPaths(
		candidates: readonly string[],
		current: ReadonlyMap<string, Uint8Array>,
	): Promise<ReadonlySet<string>>;
	/** Check these exact captured bytes against this pinned head. */
	indexMatchesHead(captured: CapturedIndex): Promise<boolean>;
	/** The index file's stored bytes, or `undefined` when there is none. */
	readIndex(): Promise<Uint8Array | undefined>;
	pathStatus(): Promise<PathStatus[]>;
	/** Unstaged changes of `paths`: the index against the files. */
	diff(paths: readonly string[]): Promise<string>;
	log(depth: number): Promise<CommitSummary[]>;
	/** Push an exact commit to the configured remote branch. */
	push(oid: string, signal: AbortSignal): Promise<void>;
	/** Fetch the configured remote branch; returns its commit, or undefined if absent. */
	fetch(signal: AbortSignal): Promise<string | undefined>;
	/** Publish files, index, and branch for an incoming fast-forward or merge. */
	publishIncoming(plan: IncomingPlan): Promise<PublishResult>;
	/**
	 * Whether incoming publication removes the directories its removals
	 * emptied, so a file may take the place of a directory whose files the
	 * same update removes, and the reverse. A backend that omits this refuses
	 * such an update as a collision.
	 */
	readonly replacesDirectories?: boolean;
	/**
	 * The recorded incoming update that has not finished. Only a backend that
	 * publishes incoming updates in steps keeps one; the others omit this.
	 */
	pendingIncoming?(): Promise<PendingIncoming | undefined>;
	/**
	 * Finish or clear the pending incoming update. Runs only when asked, inside
	 * `exclusive`; nothing resumes an update implicitly.
	 */
	recoverIncoming?(): Promise<RecoverIncomingResult>;
};
