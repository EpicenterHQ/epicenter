/**
 * What the shared history coordinator needs from a folder's Git storage.
 *
 * The browser backend keeps objects, refs, and the index in IndexedDB and
 * uses isomorphic-git. The native backend writes objects with
 * isomorphic-git but leaves index and ref mutation to the real `git` CLI,
 * whose lock files other native Git processes respect.
 *
 * Backend methods throw on failure; the coordinator turns failures into
 * reported outcomes.
 */
import type { FileChange } from '../boundary.js';
import type { FileError, FileStep } from '../errors.js';
import type { Author, CommitSummary, ObjectAccess } from './objects.js';

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

/** An incoming fast-forward prepared against observed files and refs. */
export type FastForwardPlan = {
	readonly expectedHead: string | undefined;
	readonly nextHead: string;
	readonly changes: readonly FileChange[];
	readonly paths: readonly string[];
};

export type PublishResult =
	| { readonly status: 'published' }
	/** Nothing was written. */
	| { readonly status: 'refused'; readonly error: FileError }
	/** Nothing was written (browser); or files and index were applied first (native). */
	| {
			readonly status: 'branchMoved';
			readonly actual: string | undefined;
			readonly filesApplied: boolean;
	  }
	/** Native only: some file steps reached the folder; the branch did not move. */
	| {
			readonly status: 'partial';
			readonly applied: readonly FileStep[];
			readonly error: FileError;
	  }
	/** Native only: files were applied; updating the index failed; the branch did not move. */
	| { readonly status: 'indexFailed'; readonly error: string };

export type GitBackend = {
	readonly branch: string;
	readonly remote: GitRemote | undefined;
	/** Run object work. The browser flushes new objects durably before returning. */
	withObjects<T>(work: (access: ObjectAccess) => Promise<T>): Promise<T>;
	/** Serialize this folder's index and branch work. Network work never runs inside. */
	exclusive<T>(work: () => Promise<T>): Promise<T>;
	readBranch(): Promise<string | undefined>;
	readRemoteTracking(): Promise<string | undefined>;
	/** Move the branch only if it still names `expected`. */
	casBranch(expected: string | undefined, next: string): Promise<CasResult>;
	/** Why automatic commits must not run now, such as a native merge in progress. */
	blocked(): Promise<string | undefined>;
	/**
	 * Why a whole-folder commit or fast-forward cannot represent this
	 * repository faithfully: every file is written as plain `100644` bytes
	 * with no attribute filters, so symbolic links, executables, submodules,
	 * nested Git data, and normalizing attributes are refused rather than
	 * silently rewritten. Explicit staging and staged commits are unaffected.
	 */
	checkpointProblem(): Promise<string | undefined>;
	/** Reset index entries for `paths` to their state in `commit`. */
	syncIndex(commit: string, paths: readonly string[]): Promise<void>;
	/**
	 * Make every index entry match `commit`'s tree, including staged-only
	 * additions and deletions. Returns the paths it reset.
	 */
	reconcileIndex(commit: string): Promise<string[]>;
	/** Which untracked candidates `.gitignore` (and native excludes) ignore. */
	ignoredPaths(
		candidates: readonly string[],
		current: ReadonlyMap<string, Uint8Array>,
	): Promise<ReadonlySet<string>>;
	indexMatchesHead(): Promise<boolean>;
	pathStatus(): Promise<PathStatus[]>;
	/** Stage current contents of `paths`, including deletions; `'all'` stages everything. */
	stage(paths: readonly string[] | 'all'): Promise<void>;
	/** Commit the index onto the pinned branch head. */
	commitIndex(
		message: string,
		author: Author,
	): Promise<
		| {
				readonly status: 'committed';
				readonly oid: string;
				readonly parent: string | undefined;
		  }
		| { readonly status: 'nothing' }
		| { readonly status: 'branchMoved'; readonly actual: string | undefined }
	>;
	diff(options: { staged: boolean; paths: readonly string[] }): Promise<string>;
	log(depth: number): Promise<CommitSummary[]>;
	/** Push an exact commit to the configured remote branch. */
	push(oid: string, signal: AbortSignal): Promise<void>;
	/** Fetch the configured remote branch; returns its commit, or undefined if absent. */
	fetch(signal: AbortSignal): Promise<string | undefined>;
	publishFastForward(plan: FastForwardPlan): Promise<PublishResult>;
};
