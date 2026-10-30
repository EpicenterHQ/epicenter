/**
 * The plain data one history sync request answers (ADR-0576).
 *
 * Sync never asks a person: the device syncing is the writer acting, and a
 * unit both sides changed takes its side. What lost is named in the merge
 * commit's `Overrode:` trailers and stays in history as the other parent.
 *
 * This module writes nothing and loads no Git implementation.
 */
import type { PushOutcome } from './history.js';

/**
 * What a sync run did. `synced` means the remote holds every save captured
 * before the run; `saved` means the folder recorded and merged what it
 * could, and `push` says why the remote may not have it yet.
 */
export type SyncOutcome =
	| { readonly kind: 'synced'; readonly head: string }
	| {
			readonly kind: 'saved';
			readonly head: string | undefined;
			readonly push: PushOutcome | undefined;
			/** This run observed a local change after its latest successfully recorded capture.
			 * False means no such change was observed, not that the files are clean. */
			readonly changedSince: boolean;
	  };

/** How one sync run may merge. */
export type SyncOptions = {
	/**
	 * Merge a remote history that shares no commit with this folder's, over
	 * an empty base: both roots stay in history. Without it, such a run is
	 * `Unrelated` and writes nothing. A folder's first commit merges this way
	 * on its own.
	 */
	readonly allowUnrelatedHistories?: boolean;
};
