/**
 * The account's Todos folder in this browser, and what may happen to it.
 *
 * The folder lives in OPFS under the signed-in account's own scope, so it is
 * never the Local demo's folder and never another account's. Its remote is
 * the canonical clone URL and branch the account's pairing recorded; Git
 * transfers go through `relayFetch`, pinned to the pairing's revision.
 *
 * `decideAccountFolder` is the gate: from what the directory holds
 * (`inspectFolder`, which writes nothing) and the pairing, it says what the
 * page may offer. Only an explicit Download transfers anything, and nothing
 * here attaches, changes, or replaces a remote a folder already records.
 * Opening never creates the folder (`createIfMissing: false`), so a missing
 * directory cannot become an unrelated history.
 *
 * Browser-only: reached through `#platform/start`.
 */
import {
	type DownloadError,
	downloadFolder,
	type FolderDownload,
	type FolderInspection,
	type InspectError,
	inspectFolder,
	type OpenFolderError,
	type OpfsEnvironment,
	openFolder,
} from '@epicenter/folder/browser';
import type { Result } from 'wellcrafted/result';
import { todosDefinition } from '../definition.js';
import { TODOS_FOLDER_ID, type TodosFolder } from '../platform/types.js';
import {
	type ConnectorAccount,
	type Pairing,
	relayFetch,
} from './connector.js';

/** Who records the versions this browser makes in the account's repository. */
export const ACCOUNT_AUTHOR = { name: 'Todos', email: 'todos@epicenter.so' };

/** The fixed account identity a folder scope captures, and nothing else. */
export function accountScope(
	account: Pick<ConnectorAccount, 'authorityId' | 'principalId'>,
) {
	return {
		channel: 'release' as const,
		account: {
			authorityId: account.authorityId,
			principalId: account.principalId,
		},
	};
}

/** What a folder that is already here is kept with. */
export type ExistingFolder =
	| {
			readonly kind: 'ready';
			/** `undefined` when it has no remote; `branch` is `undefined` when unrecorded. */
			readonly remote:
				| { readonly url: string; readonly branch: string | undefined }
				| undefined;
	  }
	| {
			readonly kind: 'pending';
			readonly remote: { readonly url: string; readonly branch: string };
	  };

/** What the page may offer for the account's folder. */
export type AccountFolderStep =
	/** No pairing yet: offer listing repositories and pairing one. `existing` is a folder already here. */
	| { readonly kind: 'unpaired'; readonly existing: ExistingFolder | undefined }
	/** Paired, and this browser has no folder: offer Download. */
	| { readonly kind: 'download'; readonly pairing: Pairing }
	/** Paired, and a download of the same repository and branch stopped: offer Download again. */
	| { readonly kind: 'resume'; readonly pairing: Pairing }
	/** Paired, and the folder here is kept with exactly that repository and branch: open it. */
	| { readonly kind: 'open'; readonly pairing: Pairing }
	/** Paired, and the folder here is kept with another remote, or none: refuse, leaving it as it is. */
	| {
			readonly kind: 'refused';
			readonly pairing: Pairing;
			readonly existing: ExistingFolder;
	  };

function existingOf(inspection: FolderInspection): ExistingFolder | undefined {
	switch (inspection.kind) {
		case 'absent':
			return undefined;
		case 'pending':
			return { kind: 'pending', remote: inspection.remote };
		case 'ready':
			return { kind: 'ready', remote: inspection.remote };
	}
}

/**
 * The gate. A ready folder opens only when its recorded URL and branch both
 * equal the pairing's; a folder an earlier version bound by URL alone, with
 * no branch, is not confirmed here and is refused. A pending download
 * continues only for the same URL and branch.
 */
export function decideAccountFolder(
	inspection: FolderInspection,
	pairing: Pairing | undefined,
): AccountFolderStep {
	const existing = existingOf(inspection);
	if (pairing === undefined) return { kind: 'unpaired', existing };
	if (existing === undefined) return { kind: 'download', pairing };
	const same =
		existing.remote !== undefined &&
		existing.remote.url === pairing.remote.url &&
		existing.remote.branch === pairing.remote.branch;
	if (!same) return { kind: 'refused', pairing, existing };
	return existing.kind === 'pending'
		? { kind: 'resume', pairing }
		: { kind: 'open', pairing };
}

/** Injected OPFS for tests; the browser's own otherwise. */
type OpfsOption = { readonly opfs?: OpfsEnvironment };

/** What the account's folder directory holds. Writes nothing. */
export function inspectAccountFolder(
	account: Pick<ConnectorAccount, 'authorityId' | 'principalId'>,
	{ opfs }: OpfsOption = {},
): Promise<Result<FolderInspection, InspectError>> {
	return inspectFolder({
		id: TODOS_FOLDER_ID,
		scope: accountScope(account),
		opfs,
	});
}

/**
 * Download the paired repository's history into the account's folder. Only
 * a person's Download calls this. A directory that is already a folder, or
 * holds another download, is refused unchanged.
 */
export function downloadAccountFolder(
	account: ConnectorAccount,
	pairing: Pairing,
	{ opfs, signal }: OpfsOption & { readonly signal?: AbortSignal } = {},
): Promise<Result<FolderDownload, DownloadError>> {
	return downloadFolder({
		id: TODOS_FOLDER_ID,
		scope: accountScope(account),
		remote: { url: pairing.remote.url, branch: pairing.remote.branch },
		httpFetch: relayFetch(account, pairing),
		signal,
		opfs,
	});
}

/**
 * Open the account's folder with the pairing's remote and its pinned relay.
 * Never creates it; a folder kept with another remote is `RemoteMismatch`
 * and is not changed.
 */
export function openAccountFolder(
	account: ConnectorAccount,
	pairing: Pairing,
	{ opfs }: OpfsOption = {},
): Promise<Result<TodosFolder, OpenFolderError>> {
	return openFolder({
		id: TODOS_FOLDER_ID,
		definition: todosDefinition,
		browser: {
			scope: accountScope(account),
			author: ACCOUNT_AUTHOR,
			remote: { url: pairing.remote.url, branch: pairing.remote.branch },
			httpFetch: relayFetch(account, pairing),
			createIfMissing: false,
			opfs,
		},
	});
}

/** How a folder already here is kept, in words. */
export function describeExisting(existing: ExistingFolder): string {
	if (existing.kind === 'pending')
		return `an unfinished download of ${existing.remote.url} (branch ${existing.remote.branch})`;
	const remote = existing.remote;
	if (remote === undefined)
		return 'Todos that are not connected to any repository';
	return remote.branch === undefined
		? `Todos kept with ${remote.url}, with no branch recorded`
		: `Todos kept with ${remote.url} (branch ${remote.branch})`;
}
