/**
 * The sync core's Node-API addon, typed, with `settle` from
 * `@epicenter/definition` as its note merge. Build the addon first:
 * `bun packages/epicenter-core/napi/build.ts`.
 *
 * `sync` resolves when the round ends and never rejects for a stop: a
 * round the network or a held lock interrupted is `retry`, and one a
 * person or agent must act on is `stopped`, with `message` saying why.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
// Relative until a program loads the addon and this directory becomes a
// workspace package that declares `@epicenter/definition`.
import { settle } from '../../definition/src/merge/index.ts';

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

export const addon = createRequire(import.meta.url)(
	join(import.meta.dir, 'epicenter_core.node'),
) as Addon;

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
