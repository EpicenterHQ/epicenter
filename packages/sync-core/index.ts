/**
 * The sync core addon, typed, with `settle` from `@epicenter/definition`
 * wired in as its note merge. Build the addon first:
 * `bun packages/sync-core/build-addon.ts`.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
// Relative, not `@epicenter/definition/merge`: the spike adds no workspace
// package, so the lockfile stays as it is.
import { settle } from '../definition/src/merge/index.ts';

export type SyncRemote = { url: string; token?: string; lfsUrl?: string };
export type SyncOptions = { remote?: SyncRemote; machine: string };
export type SettleInput = {
	path: string;
	base?: string;
	current: string;
	incoming: string;
	currentAuthor: string;
	currentTime: string;
	incomingAuthor: string;
	incomingTime: string;
};
export type SyncRound = {
	status: 'synced' | 'retry' | 'stopped';
	head?: string;
	notes: string[];
	message?: string;
};

type Addon = {
	syncRound(folder: string, options: SyncOptions, settle: (input: SettleInput) => string): SyncRound;
	libgit2Version(): string;
};

export const addon = createRequire(import.meta.url)(join(import.meta.dir, 'sync_core.node')) as Addon;

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

/** One round for `folder`, notes merged by `settle`. */
export function syncRound(folder: string, options: SyncOptions): SyncRound {
	return addon.syncRound(folder, options, settleNote);
}
