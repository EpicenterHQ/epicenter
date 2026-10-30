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
	Failed: ({ operation, cause }: { operation: string; cause: unknown }) => ({
		message: `Git ${operation} failed: ${describe(cause)}`,
		operation,
		cause,
	}),
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
	 * A tree that some folder could not write as plain files: a link, an
	 * executable, a submodule, a Git attribute filter, an invalid path, or two
	 * paths only their case tells apart. `whose` is the side that holds it:
	 * the remote's, which this folder cannot take, or the one this folder
	 * would send, which another device could not. Nothing was written or sent.
	 */
	Unrepresentable: ({
		whose,
		paths,
		reason,
	}: {
		whose: 'remote' | 'folder';
		paths: readonly string[];
		reason: string;
	}) => ({
		message:
			whose === 'remote'
				? `The remote's files cannot be written to this folder: ${reason}`
				: `This folder's files cannot be sent, since another folder could not hold them: ${reason}; rename or move ${paths.map((path) => `'${path}'`).join(', ')}, then sync again`,
		whose,
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
