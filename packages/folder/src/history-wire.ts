/**
 * What a desktop page asks of a folder's history and what the `epicenter`
 * CLI answers (ADR-0559). The page runs no Git: each request is one fixed
 * Rust command, which runs one CLI child over the folder, and the child
 * prints one reply line in this encoding. The CLI's `--json` output for
 * `status`, `history`, `save-version`, and `sync` is that line.
 *
 * The encoding is JSON, with an `Error` written as its name and message,
 * which `JSON.parse` reads back. Every reply is plain data under fixed keys:
 * no reply carries bytes or keys a caller chose.
 *
 * This module loads no Git and no Node API, so the page and the CLI share it.
 */
import type { Result } from 'wellcrafted/result';
import type { GitRemote } from './git/backend.js';
import type { GitError, GitInstall, SyncError } from './git/errors.js';
import type {
	Attempt,
	CommitOutcome,
	FilesObservation,
	PushOutcome,
	SyncObservation,
} from './git/history.js';
import type { CommitSummary } from './git/objects.js';
import type { SyncOutcome } from './git/sync.js';

/** One history operation, as a page asks for it. */
export type HistoryRequest =
	| { readonly op: 'status' }
	| { readonly op: 'log'; readonly depth: number }
	| { readonly op: 'saveVersion'; readonly message?: string }
	| {
			readonly op: 'sync';
			/** Make this the folder's remote first (`folder.sync.connect`). */
			readonly connect?: string;
			readonly allowUnrelatedHistories?: boolean;
	  };

/**
 * What the history knew when the operation ended, for the page's snapshot.
 * `files` and `sync` are absent when the operation did not observe them.
 */
export type HistoryState = {
	readonly branch: string;
	readonly remote: GitRemote | undefined;
	readonly files: FilesObservation | undefined;
	readonly sync: SyncObservation | undefined;
	readonly lastCommit: Attempt<CommitOutcome> | undefined;
	readonly lastPush: Attempt<PushOutcome> | undefined;
};

/**
 * One operation's reply. `landed` names the folder paths it wrote or
 * removed: an incoming update's files, which the page reports on its change
 * channel once, as a page's own Sync is reported on every host (ADR-0548).
 */
export type HistoryReply<T> = {
	readonly result: T;
	readonly state: HistoryState;
	readonly landed: readonly string[];
};

export type HistoryResults = {
	readonly status: Result<FilesObservation, GitError>;
	readonly log: Result<CommitSummary[], GitError>;
	readonly saveVersion: CommitOutcome;
	readonly sync: Result<SyncOutcome, SyncError>;
};

/**
 * The reply line when no usable `git` was found: the command did nothing,
 * and exits 2 (ADR-0558).
 */
export type GitMissingReply = {
	readonly error: 'GitMissing';
	readonly message: string;
	readonly install: GitInstall;
};

/**
 * `value` as one line of the encoding above. A failure's `cause` is
 * whatever was thrown, and an `Error` has no own enumerable properties, so
 * it is written as its name and message.
 */
export function encodeHistory(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item instanceof Error ? { name: item.name, message: item.message } : item,
	);
}
