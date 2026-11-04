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
	/** The LFS batch API base; `<url>/info/lfs` when absent. */
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

export type Addon = {
	sync(
		folder: string,
		options: SyncOptions,
		settle: (input: SettleInput) => string,
	): Promise<SyncRound>;
	libgit2Version(): string;
};

export const addon: Addon = require('./epicenter_core.node');

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
