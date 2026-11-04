/**
 * One round of `epicenter sync` for one data folder, run in this process by
 * the sync core (`@epicenter/core`, ADR-0751): commit, fetch, first
 * contact, merge with `settle`, Git LFS, and push, all under the folder's
 * round lock (`.git/epicenter-sync.lock`, ADR-0750), so the desktop app's
 * rounds, an app's own, and a person's `epicenter sync` take turns. No
 * `git` or `git-lfs` program runs, and the token is only ever an HTTP
 * header.
 *
 * The CLI admits the folder first: it must exist, be its own repository,
 * and record consent (`epicenter.synced = true`). The core refuses what
 * only a person can resolve (another branch, a merge in progress, a remote
 * `main` rewritten since the last sync, a history Epicenter did not make),
 * naming the command that resolves it (ADR-0741).
 *
 * A round ends `synced`, `retry` (transient: a lock another program holds,
 * the network, a push still rejected after every attempt; run it again), or
 * `stopped` (a person or agent must act).
 */

import { existsSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { locate, type SyncRound, sync } from '@epicenter/core';
import type { CredentialFor } from './git.ts';

export type SyncStatus = 'synced' | 'retry' | 'stopped';

export type SyncResult = {
	readonly folder: string;
	readonly status: SyncStatus;
	/** The commit the folder's repository is at when the round ends. */
	readonly head?: string;
	/** What the round did, one line each, in order. */
	readonly notes: string[];
	/** Why the round ended `retry` or `stopped`. */
	readonly message?: string;
};

export type SyncOptions = {
	/** The token for the remote, asked for by its URL. */
	readonly credential?: CredentialFor;
};

/** This computer's name, for the commit that adds a folder's files: "Added from <machine>". */
const machine = () => hostname().replace(/\.local$/i, '') || 'this computer';

/** Run one sync round for the folder at `input`. Never throws for a stop. */
export async function syncFolder(
	input: string,
	{ credential }: SyncOptions = {},
): Promise<SyncResult> {
	const folder = resolve(input);
	const stopped = (message: string): SyncResult => ({
		folder,
		status: 'stopped',
		notes: [],
		message,
	});
	if (!existsSync(folder) || !statSync(folder).isDirectory())
		return stopped(
			`${folder} does not exist. Run epicenter forget ${folder} if it is gone for good.`,
		);
	const target = await realpath(folder);
	const found = locate(target);
	if (found === null)
		return stopped(
			`${folder} is not in a Git repository. Run epicenter init ${folder}.`,
		);
	// A boolean in an enclosing repository's config cannot authorize its subfolder.
	if (found.root !== target || !found.synced)
		return stopped(
			`${folder} is not its own synced repository. Run epicenter init ${folder} again.`,
		);
	const ran = await round(target, found.origin, credential);
	return {
		folder,
		status: ran.status,
		...(ran.head === undefined ? {} : { head: ran.head }),
		notes: ran.notes,
		...(ran.message === undefined ? {} : { message: ran.message }),
	};
}

/**
 * One round in the core for the repository at `target`, with `url` as its
 * origin (none: a round that commits locally) and the token `credential`
 * gives for it. No admission: `clone` runs it in a folder it just made.
 */
export async function round(
	target: string,
	url: string | undefined,
	credential?: CredentialFor,
): Promise<SyncRound> {
	const auth = url === undefined ? undefined : await credential?.(url);
	return sync(target, {
		machine: machine(),
		...(url === undefined
			? {}
			: {
					remote: {
						url,
						...(auth === undefined ? {} : { token: auth.token }),
					},
				}),
	});
}
