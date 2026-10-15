/**
 * What a desktop page asks of a folder's history and what the `epicenter`
 * CLI answers (ADR-0559). The page runs no Git: each request is one fixed
 * Rust command, which runs one CLI child over the folder, and the child
 * prints one reply line in this encoding. The CLI's `--json` output for
 * `status`, `history`, `save-version`, and `sync` is that line.
 *
 * The encoding is JSON that also carries bytes and errors: a `Uint8Array`
 * (a binary file's version in a sync conflict) as `{"$bytes": "<base64>"}`,
 * an `Error` as its name and message, and an object whose own keys include
 * `$bytes` or `$entries` as `{"$entries": [[key, value], ...]}`, so a setting
 * that happens to look like an escape reads back as itself.
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
import type { GitCredential } from './git/http.js';
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
			readonly credential?: UrlCredential;
	  }
	| {
			readonly op: 'settle';
			/** The attempt's ID; its conflicts are read again from its commits. */
			readonly attempt: string;
			readonly choices: unknown;
			readonly credential?: UrlCredential;
	  };

/** A credential the page holds, for exactly one remote URL. */
export type UrlCredential = GitCredential & { readonly url: string };

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
	readonly settle: Result<SyncOutcome, SyncError>;
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

const ESCAPES = ['$bytes', '$entries'];

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
	return bytes;
}

/** `value` as one line of the encoding above. */
export function encodeHistory(value: unknown): string {
	// The replacer sees each value before its children, and not again the
	// value it returns, so an escape it makes is never escaped twice.
	return JSON.stringify(value, (_key, item: unknown) => {
		if (item instanceof Uint8Array) return { $bytes: toBase64(item) };
		if (item instanceof Error)
			return { name: item.name, message: item.message };
		if (
			typeof item === 'object' &&
			item !== null &&
			!Array.isArray(item) &&
			ESCAPES.some((name) => Object.hasOwn(item, name))
		)
			return { $entries: Object.entries(item) };
		return item;
	});
}

/** One line of the encoding above, as the value it carried. */
export function decodeHistory<T>(line: string): T {
	return JSON.parse(line, (_key, item: unknown) => {
		if (typeof item !== 'object' || item === null || Array.isArray(item))
			return item;
		const keys = Object.keys(item);
		if (keys.length !== 1) return item;
		const record = item as Record<string, unknown>;
		if (keys[0] === '$bytes' && typeof record.$bytes === 'string')
			return fromBase64(record.$bytes);
		if (keys[0] === '$entries' && Array.isArray(record.$entries))
			return Object.fromEntries(record.$entries as [string, unknown][]);
		return item;
	}) as T;
}
