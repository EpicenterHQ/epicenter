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
import type { ApplyError, FileError, FileStep } from '../errors.js';
import type { DeclaredAttribute } from './attributes.js';
import type { CapturedIndex } from './captured-index.js';
import type {
	Author,
	CommitSummary,
	ObjectAccess,
	TreeFile,
} from './objects.js';

export type StatusCode = ' ' | 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

/** One path's staged (`index`) and unstaged (`worktree`) state, as `git status` reports it. */
export type PathStatus = {
	readonly path: string;
	readonly index: StatusCode;
	readonly worktree: StatusCode;
};

/**
 * The folder's remote: Git configuration's `remote.origin.url`, and the
 * remote branch, which is always the local branch.
 */
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
	/** The branch moved after it was pinned. Nothing was written. */
	| { readonly status: 'branchMoved'; readonly actual: string | undefined }
	/**
	 * The update stopped after it wrote, or may have written, the folder
	 * paths in `landed`; the branch did not reach `nextHead`. No host records
	 * the update (ADR-0545): those paths differ from `HEAD`, status shows them
	 * as changed, and the next Sync records them and merges with the tracking
	 * ref.
	 */
	| {
			readonly status: 'interrupted';
			readonly landed: readonly string[];
			readonly error: string;
	  };

const stepPaths = (step: FileStep | FileChange) =>
	step.kind === 'move' ? [step.from, step.to] : [step.path];

/**
 * What an incoming update's file steps failing with `error` leaves, after
 * the paths in `landed` already landed: `refused` when nothing landed and the
 * failed step certainly wrote nothing, `interrupted` otherwise.
 */
export function stoppedApplying(
	changes: readonly FileChange[],
	error: FileError | ApplyError,
	landed: readonly string[] = [],
): PublishResult {
	const reached =
		error.name === 'Partial'
			? [
					...landed,
					...error.applied.flatMap(stepPaths),
					...(error.error.name === 'Unconfirmed'
						? stepPaths(error.failed)
						: []),
				]
			: error.name === 'Unconfirmed'
				? [...landed, ...changes.flatMap(stepPaths)]
				: landed;
	if (reached.length === 0)
		return {
			status: 'refused',
			error: error.name === 'Partial' ? error.error : error,
		};
	return { status: 'interrupted', landed: reached, error: error.message };
}

export type GitBackend = {
	/**
	 * Create the repository if there is none yet. A directory backend has
	 * this; history calls it inside `exclusive` before a whole-folder commit,
	 * and staging or setting a remote creates it too. The browser backend
	 * creates its own with its first Git write. No backend creates one when
	 * the folder opens.
	 * Answers why no repository may be created here, having created nothing.
	 */
	createRepository?(): Promise<string | undefined>;
	readonly branch: string;
	/** The remote as this backend last read or set it. */
	readonly remote: GitRemote | undefined;
	/**
	 * Read `remote.origin.url` again, so a remote another page or program set
	 * is used. Writes nothing; a folder with no repository yet has none.
	 */
	refreshRemote(): Promise<GitRemote | undefined>;
	/**
	 * Make `url` the folder's remote in Git configuration, creating the
	 * repository if the folder has none yet. Transfers nothing.
	 */
	setRemote(url: string): Promise<GitRemote>;
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
	 * as ordinary content. Explicit staging and staged commits are unaffected.
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
	/** Stage current contents of `paths`, including deletions; `'all'` stages everything. */
	stage(paths: readonly string[] | 'all'): Promise<void>;
	/**
	 * Commit the index's tree onto the branch head pinned when the commit
	 * starts. A tree equal to the parent's is `nothing`. The branch moves only
	 * if it still names the pinned parent; otherwise the result is
	 * `branchMoved` and no ref or index entry changes.
	 */
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
		| {
				readonly status: 'branchMoved';
				readonly expected: string | undefined;
				readonly actual: string | undefined;
		  }
	>;
	diff(options: { staged: boolean; paths: readonly string[] }): Promise<string>;
	log(depth: number): Promise<CommitSummary[]>;
	/** Push an exact commit to the configured remote branch. */
	push(oid: string, signal: AbortSignal): Promise<void>;
	/** Fetch the configured remote branch; returns its commit, or undefined if absent. */
	fetch(signal: AbortSignal): Promise<string | undefined>;
	/** Publish an incoming fast-forward or merge: files, then the index, then the branch. */
	publishIncoming(plan: IncomingPlan): Promise<PublishResult>;
	/**
	 * Whether incoming publication removes the directories its removals
	 * emptied, so a file may take the place of a directory whose files the
	 * same update removes, and the reverse. A backend that omits this refuses
	 * such an update as a collision.
	 */
	readonly replacesDirectories?: boolean;
};
