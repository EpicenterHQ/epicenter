/**
 * Git operation failures for file folders.
 *
 * These live apart from `history.ts` so code that only reports them, such as
 * an app's error handling, can build the same errors without loading the Git
 * implementation.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { describe } from '../errors.js';
import type { CommitOutcome } from './history.js';

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
	/**
	 * No usable `git` was found, so history cannot run; files still read and
	 * save (ADR-0559). `install` names how this computer gets one: the
	 * Command Line Tools on macOS, Git for Windows, or the system's package
	 * manager.
	 */
	GitMissing: ({
		operation,
		install,
	}: {
		operation: string;
		install: GitInstall;
	}) => ({
		message: `Git ${operation} needs git, which is not installed on this computer`,
		operation,
		install,
	}),
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

/** How a computer without `git` gets one. */
export type GitInstall =
	| 'command-line-tools'
	| 'git-for-windows'
	| 'package-manager';

/**
 * Why `folder.sync` stopped. Sync never stops because changes compete
 * (ADR-0576): each of these is a state it cannot represent or must not
 * decide, or a step that failed, and each carries what that step reported.
 */
export const SyncError = defineErrors({
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
	 * The repository or the folder is in a state Sync must not change: a
	 * merge or a rebase another Git program began, a detached head, a file of
	 * the folder's own where the remote needs the path, or a branch another
	 * program moved while Sync wrote. `reason` names it.
	 */
	Blocked: ({ reason }: { reason: string }) => ({
		message: `Sync cannot run now: ${reason}`,
		reason,
	}),
	/**
	 * The remote holds what this folder cannot write as plain files: a link,
	 * an executable, a submodule, a Git attribute filter, an invalid path, or
	 * two paths only their case tells apart. Nothing was written or sent.
	 */
	Unrepresentable: ({
		paths,
		reason,
	}: {
		paths: readonly string[];
		reason: string;
	}) => ({
		message: `The remote's files cannot be written to this folder: ${reason}`,
		paths,
		reason,
	}),
	/**
	 * Another device pushed between each fetch and push, `attempts` times.
	 * Nothing of this run was sent, and the folder is as the checkpoint left it.
	 */
	KeptChanging: ({ attempts }: { attempts: number }) => ({
		message: `The remote kept changing while this folder synced; gave up after ${attempts} attempts`,
		attempts,
	}),
	/**
	 * Writing the synced files stopped partway. Each file holds its old bytes
	 * or its new ones, and the next Sync records and merges them (ADR-0545).
	 */
	Publish: ({ path, error }: { path: string; error: string }) => ({
		message: `Synced files could not all be written; the next Sync finishes them. ${path}: ${error}`,
		path,
		error,
	}),
	/** Sync stopped on an unexpected failure. */
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `Sync failed: ${describe(cause)}`,
		cause,
	}),
});
export type SyncError = InferErrors<typeof SyncError>;
