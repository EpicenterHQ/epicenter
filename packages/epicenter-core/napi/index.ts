/**
 * `@epicenter/core`: the sync core's Node-API addon, typed, with `settle`
 * from `@epicenter/definition` as its note merge. Build the addon first:
 * `bun run --cwd packages/epicenter-core build`.
 *
 * The addon is loaded with a `require` of a literal relative path, the form
 * `bun build --compile` follows to embed a `.node` file in the executable,
 * so the compiled `epicenter` carries the core and needs no file beside it.
 *
 * `sync` resolves when the round ends and never rejects for a stop: a
 * round the network or a held lock interrupted is `retry`, and one a
 * person or agent must act on is `stopped`, with `message` saying why.
 * `open`, `locate`, `setSynced`, and `connect` turn sync on for a folder
 * before its first round; they throw an `Error` carrying the core's
 * refusal, which names the command that resolves it.
 */
import { settle } from '@epicenter/definition/merge';

/** One note both sides changed, as the core hands it to `settle`. */
export type SettleInput = {
	path: string;
	base?: string;
	/** What `origin/main` holds. */
	current: string;
	/** This machine's text, arriving after it. */
	incoming: string;
	currentAuthor: string;
	currentTime: string;
	incomingAuthor: string;
	incomingTime: string;
};

export type SyncRemote = {
	url: string;
	/** Sent as `Authorization: Bearer <token>` to the remote's origin; never stored. */
	token?: string;
	/**
	 * The LFS batch API base. When absent: the folder's Git LFS
	 * configuration (`remote.origin.lfsurl`, then `lfs.url`), else
	 * `<url>/info/lfs` for an HTTP remote.
	 */
	lfsUrl?: string;
};

export type SyncOptions = {
	remote?: SyncRemote;
	/** The computer's name, for "Added from <machine>". */
	machine: string;
	/** How long to wait for another round on the folder; two minutes when absent. */
	turnWaitMs?: number;
};

export type SyncRound = {
	status: 'synced' | 'retry' | 'stopped';
	head?: string;
	/** What the round did, one line each, in order. */
	notes: string[];
	message?: string;
};

/** A folder's repository, opened or just made. */
export type Opened = {
	/** Whether this call made the repository. */
	initialized: boolean;
	/** The Git LFS filter settings this call wrote, in order. */
	configured: string[];
};

/** The repository a folder is in. */
export type Located = {
	/** The top of the working tree, links resolved. */
	root: string;
	/** Whether the repository's own configuration records consent to sync. */
	synced: boolean;
	/** `remote.origin.url`, when set. */
	origin?: string;
};

export type Addon = {
	sync(
		folder: string,
		options: SyncOptions,
		settle: (input: SettleInput) => string,
	): Promise<SyncRound>;
	open(folder: string): Opened;
	locate(folder: string): Located | null;
	setSynced(folder: string, synced: boolean): boolean;
	connect(folder: string, url: string): boolean;
	libgit2Version(): string;
};

export const addon: Addon = require('./epicenter_core.node');

/**
 * Open the folder's own repository, or make one with `main` and no commits
 * (ADR-0735), and write the Git LFS filter settings it lacks (ADR-0733).
 * Throws, writing nothing, for a repository on another branch, mid-merge,
 * or in any other state only a person can finish (ADR-0741).
 */
export const open = (folder: string): Opened => addon.open(folder);

/**
 * The repository whose working tree holds `folder`, searching upward as
 * `git rev-parse --show-toplevel` does and honoring
 * `GIT_CEILING_DIRECTORIES`; null when there is none, or it is bare.
 */
export const locate = (folder: string): Located | null => addon.locate(folder);

/**
 * Record or clear consent to sync, `epicenter.synced = true` in the
 * folder's own `.git/config` (ADR-0750). Returns whether it changed.
 */
export const setSynced = (folder: string, synced: boolean): boolean =>
	addon.setSynced(folder, synced);

/**
 * Make `url` the folder's `origin`, forgetting the last remote `main` seen.
 * Returns whether it was added; throws when `origin` is another remote or
 * pushes elsewhere.
 */
export const connect = (folder: string, url: string): boolean =>
	addon.connect(folder, url);

/** `settle` as the core calls it: the merged text of one note. */
export function settleNote(input: SettleInput): string {
	const settled = settle(input.base ?? null, input.current, input.incoming, {
		parties: {
			current: { author: input.currentAuthor, time: input.currentTime },
			incoming: { author: input.incomingAuthor, time: input.incomingTime },
		},
	});
	return settled.text ?? input.current;
}

/** One round for `folder`, notes merged by `settle`, off the JavaScript thread. */
export function sync(folder: string, options: SyncOptions): Promise<SyncRound> {
	return addon.sync(folder, options, settleNote);
}
