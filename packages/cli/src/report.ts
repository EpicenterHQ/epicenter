/**
 * What one run of an action left behind (ADR-0850): the one value `--json`
 * prints, MCP returns, and stderr renders. Every run that started has one;
 * a command that did not run has a `CliError` instead.
 */

/** The commit `epicenter` made for a run: its full sha, subject, and the paths it holds. */
export type Commit = { sha: string; subject: string; paths: string[] };

/**
 * What became of one path the action wrote:
 *
 * - `committed`: in the run's commit.
 * - `already-in-history`: HEAD already held the action's bytes, so there was nothing to commit.
 * - `changed-after`: committed, and someone changed the file on disk since; that edit is uncommitted.
 * - `contested`: a commit made during the run changed it to something else; that commit wins, and the action's bytes are not in history.
 * - `not-committed`: the commit failed.
 */
export type PathState =
	| 'committed'
	| 'already-in-history'
	| 'changed-after'
	| 'contested'
	| 'not-committed';

/** Why a write was refused before it landed. */
export type RefusalReason =
	| 'uncommitted'
	| 'changed-during'
	| 'symlink'
	| 'lfs-not-installed'
	| 'lfs-not-set-up';

/** A write the run refused; nothing was written to `path`. */
export type Refused = {
	path: string;
	reason: RefusalReason;
	message: string;
	next?: string;
};

/** What the push after the commit did, and how far the branch is from `origin` afterwards. */
export type Push = {
	pushed: boolean;
	ahead: number;
	behind: number;
	reason?: string;
	next?: string;
};

export type RunReport = {
	/** What `run` did: the value it returned (`null` for nothing), or what it threw. */
	action:
		| { returned: unknown }
		| { threw: { message: string; thrown?: Record<string, unknown> } };
	refused: Refused[];
	/** The run's commit; `null` when there was nothing to commit; `failed` when Git refused it. */
	commit: Commit | { failed: string } | null;
	/** Every path the action wrote and the run recorded, sorted. */
	paths: { path: string; state: PathState }[];
	/** `null` when nothing was pushed: no commit, or the branch tracks no branch of its own name on `origin`. */
	push: Push | null;
};

/** A run whose child ended without a report: what HEAD was before and is now says what landed. */
export type Unknown = {
	unknown: {
		message: string;
		head: { before: string | null; after: string | null };
	};
};

/**
 * What a command that runs an action answers: the run's report, a run whose
 * child ended without one, or why nothing ran. The CLI presents it and MCP
 * returns it.
 */
export type Answer =
	| RunReport
	| Unknown
	| { error: { name: string; message: string; next?: string } };

/**
 * 0: it ran and nothing went wrong. 2: it did not run. 3: it threw, a write
 * was refused, the commit failed, or the run ended without a report.
 */
export function exitCodeOf(answer: Answer): 0 | 2 | 3 {
	if ('error' in answer) return 2;
	if ('unknown' in answer) return 3;
	const failed =
		'threw' in answer.action ||
		answer.refused.length > 0 ||
		(answer.commit !== null && 'failed' in answer.commit);
	return failed ? 3 : 0;
}
