/**
 * The sync core addon, typed, with `settle` from `@epicenter/definition`
 * wired in as its note merge. Build the addon first:
 * `bun packages/sync-core/build-addon.ts`.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type SettleInput, settleNote } from './settle-note.ts';

export { type SettleInput, settleNote };
export type SyncRemote = { url: string; token?: string; lfsUrl?: string };
export type SyncOptions = { remote?: SyncRemote; machine: string };
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

/** One round for `folder`, notes merged by `settle`. */
export function syncRound(folder: string, options: SyncOptions): SyncRound {
	return addon.syncRound(folder, options, settleNote);
}
