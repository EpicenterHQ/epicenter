/**
 * Git operation failures for file folders.
 *
 * These live apart from `history.ts` so code that only reports them, such as
 * an app's error handling, can build the same errors without loading the Git
 * implementation.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { describe, type FileError } from '../errors.js';
import type { CommitOutcome } from './history.js';
import type { SyncAttempt } from './sync.js';

export const GitError = defineErrors({
	Unconfirmed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `The folder host did not confirm Git ${operation}; the operation may have completed: ${describe(cause)}`,
		operation,
		cause,
	}),
	Failed: ({ operation, cause }: { operation: string; cause: unknown }) => ({
		message: `Git ${operation} failed: ${describe(cause)}`,
		operation,
		cause,
	}),
	Closed: () => ({ message: 'The folder is closed' }),
	NoRemote: () => ({ message: 'No remote is configured for this folder' }),
	StoppedWaiting: ({ operation }: { operation: string }) => ({
		message: `Stopped waiting for Git ${operation}; the shared attempt may still complete`,
		operation,
	}),
	InvalidMessage: ({ reason }: { reason: string }) => ({
		message: `The commit message is not usable: ${reason}`,
		reason,
	}),
	NothingToCommit: () => ({ message: 'Nothing is staged to commit' }),
	BranchMoved: ({
		expected,
		actual,
	}: {
		expected: string | undefined;
		actual: string | undefined;
	}) => ({
		message: 'The branch moved while the commit was being written',
		expected,
		actual,
	}),
});
export type GitError = InferErrors<typeof GitError>;

export const PullError = defineErrors({
	NoFetchedHead: () => ({
		message: 'No fetched remote head is available; fetch first',
	}),
	Blocked: ({ reason }: { reason: string }) => ({
		message: `The folder cannot be updated now: ${reason}`,
		reason,
	}),
	Diverged: ({ head, fetched }: { head: string; fetched: string }) => ({
		message:
			'Local and remote history have diverged; this folder only applies fast-forwards',
		head,
		fetched,
	}),
	Dirty: ({ paths }: { paths: readonly string[] }) => ({
		message: `${paths.length} uncommitted ${paths.length === 1 ? 'change blocks' : 'changes block'} the update`,
		paths,
	}),
	StagedChanges: () => ({
		message: 'Staged changes block the update',
	}),
	Collision: ({ paths }: { paths: readonly string[] }) => ({
		message: `The update would overwrite ${paths.length === 1 ? 'an ignored or untracked file' : `${paths.length} ignored or untracked files`}: ${paths.join(', ')}`,
		paths,
	}),
	Unrepresentable: ({
		paths,
		reason,
	}: {
		paths: readonly string[];
		reason: string;
	}) => ({
		message: `The incoming commit cannot be written to this folder: ${reason}`,
		paths,
		reason,
	}),
	Refused: ({ error }: { error: FileError }) => ({
		message: `A file changed before the update could be written: ${error.message}`,
		error,
	}),
	/** The branch moved after it was pinned. Nothing was written. */
	BranchMoved: ({ actual }: { actual: string | undefined }) => ({
		message:
			'The branch moved before the update could be published; nothing was written',
		actual,
	}),
	/**
	 * The update stopped after it wrote, or may have written, `paths`; the
	 * branch did not reach the incoming commit. Nothing records the update:
	 * those paths show as changed files, and the next sync records them and
	 * merges with the remote (ADR-0545).
	 */
	Interrupted: ({
		paths,
		error,
	}: {
		paths: readonly string[];
		error: string;
	}) => ({
		message: `The update stopped partway; ${paths.length} ${paths.length === 1 ? 'file it wrote shows' : 'files it wrote show'} as changed until the next sync: ${error}`,
		paths,
		error,
	}),
});
export type PullError = InferErrors<typeof PullError>;

/**
 * One reason a merge could not combine both sides by itself. `ours` is the
 * local branch and `theirs` the fetched remote head, as in Git.
 */
export type MergeConflict =
	/** Both sides changed the same lines of a text file. */
	| { readonly reason: 'content'; readonly path: string }
	/**
	 * Both sides changed a file whose bytes are not merged as text here: not
	 * UTF-8, holding a NUL byte, or holding line breaks the line merge would
	 * not keep (a lone carriage return, U+2028, or U+2029).
	 */
	| { readonly reason: 'binary'; readonly path: string }
	/** One side deleted a file the other side changed. */
	| {
			readonly reason: 'deleted';
			readonly path: string;
			readonly deletedBy: 'ours' | 'theirs';
	  }
	/** One side has a file where the other has a directory. */
	| { readonly reason: 'shape'; readonly path: string }
	/** Both sides changed one root key of `kv.json` to different values. Values are raw JSON text, `null` for an absent key. */
	| {
			readonly reason: 'kvKey';
			readonly path: string;
			readonly key: string;
			readonly base: string | null;
			readonly ours: string | null;
			readonly theirs: string | null;
	  }
	/** One side deleted `kv.json` while the other changed its values. */
	| { readonly reason: 'kvFile'; readonly path: string }
	/** Both sides changed `kv.json`, and `side`'s text is not a KV object `mergeKv` accepts. */
	| {
			readonly reason: 'kvInvalid';
			readonly path: string;
			readonly side: 'base' | 'ours' | 'theirs';
	  };

/**
 * What a command-line tool says when a merge or pull refuses competing changes:
 * the folder never leaves a conflict in its files, and Sync is how a person
 * settles one.
 */
export const CONFLICTS_NEED_SYNC =
	'Automatic merge failed; nothing was written. Competing changes are settled with Sync, which asks you before it writes them.';

/**
 * One conflicted file's committed bytes on each side of a refused merge, as
 * stored: `ours` at the local head, `theirs` at the fetched head, `null`
 * where that side has no file.
 */
export type ConflictVersion = {
	readonly path: string;
	readonly ours: Uint8Array | null;
	readonly theirs: Uint8Array | null;
};

export const MergeError = defineErrors({
	/**
	 * The two heads have no common commit, or more than one best one. No
	 * common commit merges only with `allowUnrelatedHistories`.
	 */
	UnsupportedHistory: ({
		head,
		fetched,
		bases,
	}: {
		head: string;
		fetched: string;
		bases: number;
	}) => ({
		message:
			bases === 0
				? 'Local and remote history share no commit, so they cannot be merged'
				: `Local and remote history have ${bases} merge bases; only a single merge base is supported`,
		head,
		fetched,
		bases,
	}),
	/** A path would need a merge this folder does not perform faithfully. Nothing was written. */
	Unmergeable: ({
		paths,
		reason,
	}: {
		paths: readonly string[];
		reason: string;
	}) => ({
		message: `The histories cannot be merged here: ${reason}`,
		paths,
		reason,
	}),
	/**
	 * Competing changes need a person. Nothing was written to files, the
	 * index, or the branch. A merge asked to leave its conflicts gets this
	 * only for conflicts it cannot leave as files: a file against a directory.
	 * Asked for `versions`, it carries each conflicted file's bytes on both
	 * sides; otherwise `versions` is undefined.
	 */
	Conflicted: ({
		conflicts,
		versions,
	}: {
		conflicts: readonly MergeConflict[];
		versions?: readonly ConflictVersion[];
	}) => ({
		message: `${conflicts.length} ${conflicts.length === 1 ? 'conflict blocks' : 'conflicts block'} the merge: ${[
			...new Set(conflicts.map((conflict) => conflict.path)),
		].join(', ')}`,
		conflicts,
		versions,
	}),
});
export type MergeError = InferErrors<typeof MergeError>;

/**
 * Why submitted choices cannot settle an attempt, for one entry or for the
 * choices as a whole. `message` is for a person fixing the choice:
 *
 * - `malformed`: the choices are not an object keyed by conflict ID, or this
 *   entry is not a choice
 * - `unknown`: an own key names no conflict of the attempt
 * - `missing`: no own entry answers this conflict, or it holds `undefined`
 * - `disallowed`: the conflict does not allow this operation
 * - `invalid`: the folder refuses the value, as a save would
 */
export type SyncChoiceProblem = {
	/** The entry's key; absent when the choices themselves are malformed. */
	readonly conflictId?: string;
	readonly reason:
		| 'malformed'
		| 'unknown'
		| 'missing'
		| 'disallowed'
		| 'invalid';
	readonly message: string;
};

/**
 * Why `folder.sync` stopped. Each names the step that stopped it and
 * carries that step's own result. `NeedsChoices` and `InvalidChoices` keep an
 * attempt current.
 */
export const SyncError = defineErrors({
	/**
	 * The run merged everything it could; `attempt` holds the conflicts that
	 * need a person's choice. Nothing conflicted was written and nothing was
	 * sent. Answer it with `resolve(attempt, choices)`.
	 */
	NeedsChoices: ({ attempt }: { attempt: SyncAttempt }) => ({
		message: `${attempt.conflicts.length} ${attempt.conflicts.length === 1 ? 'change needs' : 'changes need'} a choice`,
		attempt,
	}),
	Closed: () => ({ message: 'The folder is closed' }),
	NoRemote: () => ({ message: 'No remote is configured for this folder' }),
	/**
	 * The remote's history shares no commit with this folder's. Nothing was
	 * written or sent; run again with `allowUnrelatedHistories` to combine them.
	 */
	Unrelated: ({ head }: { head: string }) => ({
		message:
			'This folder and the remote have separate histories. Combining them keeps both.',
		head,
	}),
	/** Saved files could not be committed first. Nothing was fetched or sent. */
	Checkpoint: ({
		outcome,
	}: {
		outcome: Exclude<CommitOutcome, { status: 'committed' | 'unchanged' }>;
	}) => ({
		message: `Saved files could not be recorded before syncing: ${
			outcome.status === 'blocked'
				? outcome.reason
				: 'error' in outcome
					? outcome.error
					: outcome.status
		}`,
		outcome,
	}),
	/** The checkpoint landed; fetching failed, so nothing was merged or sent. */
	Fetch: ({ error }: { error: GitError }) => ({
		message: `Fetching failed: ${error.message}`,
		error,
	}),
	/**
	 * Merging or publishing stopped. `error` is the merge's own result, so
	 * `Interrupted` names the files that landed. Nothing was sent.
	 */
	Merge: ({ error }: { error: MergeError | PullError | GitError }) => ({
		message: `Incoming changes could not be merged: ${error.message}`,
		error,
	}),
	/**
	 * Competing changes sync cannot offer for review: a file that is a link,
	 * executable, or submodule in a version, or a file against a directory. Nothing was written or sent; repair them with Git
	 * outside the folder, then sync again.
	 */
	Unreviewable: ({ conflicts }: { conflicts: readonly MergeConflict[] }) => ({
		message: `${conflicts.length === 1 ? 'A change conflicts' : `${conflicts.length} changes conflict`} in a way sync cannot review: ${[
			...new Set(conflicts.map((conflict) => conflict.path)),
		].join(', ')}`,
		conflicts,
	}),
	/** The choices cannot settle the attempt. Nothing was written; the attempt stays current. */
	InvalidChoices: ({
		problems,
	}: {
		problems: readonly SyncChoiceProblem[];
	}) => ({
		message: `${problems.length === 1 ? 'A choice needs' : `${problems.length} choices need`} a fix: ${problems
			.map(({ message }) => message)
			.join('; ')}`,
		problems,
	}),
	/**
	 * The attempt no longer describes the folder. Nothing was written; sync
	 * again to review the latest changes.
	 *
	 * - `replaced`: another run, a resolve, or closing retired it, or this
	 *   folder handle did not prepare it
	 * - `changed`: the branch moved or saved files changed since it was
	 *   captured
	 */
	Stale: ({ reason }: { reason: 'replaced' | 'changed' }) => ({
		message:
			reason === 'replaced'
				? 'This sync review is no longer current; sync again'
				: 'Files changed after this sync review was prepared; sync again',
		reason,
	}),
	/** Sync stopped on an unexpected failure. */
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `Sync failed: ${describe(cause)}`,
		cause,
	}),
});
export type SyncError = InferErrors<typeof SyncError>;
