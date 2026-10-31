/**
 * How a desktop app's folder reaches Epicenter (decisions 81 and 82): the
 * app asks the shell to open `epicenter://init?path=<folder>&contract=<url>`,
 * naming the folder it keeps its files in (`folder` in its `appConfig`
 * settings) and the URL its contract is published at (an app constant: the
 * published URL is deployment, not data). Epicenter, if installed, asks the
 * person where to sync the folder and runs `epicenter init`. The app can also
 * ask whether Epicenter already syncs a folder.
 */
import { isTauri } from '@tauri-apps/api/core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { commands, type SyncRequestError } from './native/bindings.gen.js';

export const EpicenterSyncError = defineErrors({
	/** Not in a desktop window, so there is no shell to ask. */
	NotTauri: () => ({
		message: 'Only the desktop app can ask Epicenter to sync a folder.',
	}),
	/** The shell refused or could not answer; `message` says why. */
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: describe(cause),
		cause,
	}),
});
export type EpicenterSyncError = InferErrors<typeof EpicenterSyncError>;

/**
 * Ask the operating system to open Epicenter with a request to sync the
 * folder at `path` under the contract published at `contract`. `path` is a
 * root this window opened (its data folder); the shell refuses any other.
 * Ok means the system took the request; whether Epicenter sets the folder up
 * is the person's choice there, so never say the folder is syncing yet.
 *
 * ```ts
 * const { error } = await syncWithEpicenter({
 * 	path: folder,
 * 	contract: 'https://capture.epicenter.so/contract.json',
 * });
 * ```
 */
export async function syncWithEpicenter({
	path,
	contract,
}: {
	path: string;
	contract: string;
}): Promise<Result<undefined, EpicenterSyncError>> {
	if (!isTauri()) return EpicenterSyncError.NotTauri();
	const sent = await commands
		.syncWithEpicenter(path, contract)
		.catch((cause: unknown) => ({ data: null, error: cause }));
	if (sent.error !== null)
		return EpicenterSyncError.Unavailable({ cause: sent.error });
	return Ok(undefined);
}

/**
 * Whether Epicenter syncs the folder at `path`: true once `epicenter init`
 * set it up (its `.git/config` names it as `epicenter.root`). Asks again
 * each call, since that can happen while the app is open.
 */
export async function syncedWithEpicenter({
	path,
}: {
	path: string;
}): Promise<Result<boolean, EpicenterSyncError>> {
	if (!isTauri()) return EpicenterSyncError.NotTauri();
	const answer = await commands
		.syncedWithEpicenter(path)
		.catch((cause: unknown) => ({ data: null, error: cause }));
	if (answer.error !== null)
		return EpicenterSyncError.Unavailable({ cause: answer.error });
	return Ok(answer.data === true);
}

/** The shell's own refusals; anything else is what Tauri rejected with. */
function isRefusal(cause: unknown): cause is SyncRequestError {
	return typeof cause === 'object' && cause !== null && 'name' in cause;
}

/** The shell's refusal as a sentence. */
function describe(cause: unknown): string {
	if (!isRefusal(cause)) return String(cause);
	switch (cause.name) {
		case 'Folder':
			return `${cause.path} is not a folder this window can use.`;
		case 'Contract':
			return `${cause.url} is not a contract URL.`;
		case 'NotOpened':
			return `The system did not open Epicenter: ${cause.message}`;
	}
}
