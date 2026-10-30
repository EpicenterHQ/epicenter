/** Native Git storage needed by one history request. Methods throw on failure. */
import type { CommitSummary, ObjectAccess } from './objects.js';

/**
 * How a remote names its refusal to move a branch that moved after it
 * advertised it, or that a push is not a fast-forward of: Git's
 * `non-fast-forward` and `fetch first`, receive-pack's `failed to update
 * ref` and `cannot lock ref`, and the reasons Git 2.49 and later give for a
 * ref update whose old value no longer holds. A push refused for one of
 * these is `'rejected'`, and Sync fetches again; a remote that refused one
 * without moving is then a failure. A race worded otherwise is a failed
 * push, whose merge the next Sync merges again.
 */
export const REMOTE_MOVED =
	/non-fast-forward|fetch first|failed to update ref|cannot lock ref|incorrect old value provided|reference already exists|reference does not exist/i;

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

export type GitBackend = {
	/**
	 * Create the repository if there is none yet. A directory backend has
	 * this; history calls it under the request history lock before a checkpoint,
	 * and setting a remote creates it too. Reading history creates no repository.
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
	/** Supply object access. The callback owns and awaits every operation it starts. */
	withObjects<T>(work: (access: ObjectAccess) => Promise<T>): Promise<T>;
	readBranch(): Promise<string | undefined>;
	readRemoteTracking(): Promise<string | undefined>;
	/** Move the branch only if it still names `expected`. */
	casBranch(expected: string | undefined, next: string): Promise<CasResult>;
	/**
	 * `refs/epicenter/publishing`: the publish Sync began and has not
	 * finished, as a commit whose parents are the branch it began from, when
	 * there was one, and the commit it publishes. `undefined` when none is.
	 */
	readPublishing(): Promise<string | undefined>;
	/** Point `refs/epicenter/publishing` at `oid`, or delete it with `undefined`. */
	writePublishing(oid: string | undefined): Promise<void>;
	/**
	 * Why no whole-folder commit or publish may run now. A Git operation is
	 * in progress: a detached `HEAD`, a rebase, or a merge another Git
	 * program began (`MERGE_HEAD`), which the folder never begins and Git
	 * outside it finishes or abandons. Or the repository is one such a commit
	 * cannot represent faithfully: every file is written as plain `100644`
	 * bytes with no attribute filters, so symbolic links, executables,
	 * submodules, nested Git data, and an attribute file that names a filter
	 * are refused rather than silently rewritten. Unmerged index stages another Git
	 * program left are refused too: a checkpoint would reset them and record
	 * conflict markers as ordinary content.
	 */
	blocked(): Promise<string | undefined>;
	/**
	 * Make every index entry match `commit`'s tree, including staged-only
	 * additions and deletions. Working files are not touched.
	 */
	reconcileIndex(commit: string): Promise<void>;
	/** Which untracked candidates captured `.gitignore` bytes and native excludes ignore. */
	ignoredPaths(
		candidates: readonly string[],
		rules: ReadonlyMap<string, Uint8Array>,
	): Promise<ReadonlySet<string>>;
	log(depth: number): Promise<CommitSummary[]>;
	/**
	 * Push an exact commit to the configured remote branch, never forcing:
	 * `'rejected'` when the remote branch moved on and the commit does not
	 * descend from it. Throws for any other failure.
	 */
	push(
		oid: string,
		signal: AbortSignal,
	): Promise<
		{ status: 'pushed'; trackingWarning: string | undefined } | 'rejected'
	>;
	/** Fetch the configured remote branch; returns its commit, or undefined if absent. */
	fetch(signal: AbortSignal): Promise<string | undefined>;
};
