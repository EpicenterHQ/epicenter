/**
 * How a desktop app's folder reaches Epicenter (decisions 81 and 82): the
 * app asks the shell to open `epicenter://init?path=<folder>&contract=<url>`,
 * naming its data root, which the shell writes out as the path it named it
 * at, and the URL its contract is published at (an app constant: the
 * published URL is deployment, not data). Epicenter, if installed, asks the
 * person where to sync the folder and runs `epicenter init`. The app can also
 * ask whether Epicenter already syncs its folder.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { commands, type SyncRequestError } from './native/bindings.gen.js';

export const EpicenterSyncError = defineErrors({
	/** The shell refused or could not answer; `message` says why. */
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: describe(cause),
		cause,
	}),
});
export type EpicenterSyncError = InferErrors<typeof EpicenterSyncError>;

/**
 * Ask the operating system to open Epicenter with a request to sync the
 * open Data folder under the contract published at `contract`.
 * Ok means the system took the request; whether Epicenter sets the folder up
 * is the person's choice there, so never say the folder is syncing yet.
 *
 * ```ts
 * const { error } = await syncWithEpicenter({
 * 	contract: 'https://capture.epicenter.so/contract.json',
 * });
 * ```
 */
export async function syncWithEpicenter({
	contract,
}: {
	contract: string;
}): Promise<Result<undefined, EpicenterSyncError>> {
	const sent = await commands
		.syncWithEpicenter(contract)
		.catch((cause: unknown) => ({ data: null, error: cause }));
	if (sent.error !== null)
		return EpicenterSyncError.Unavailable({ cause: sent.error });
	return Ok(undefined);
}

/**
 * Whether Epicenter has adopted the open Data folder for local history:
 * true once `epicenter init` set `epicenter.synced`. The historical method
 * name does not imply that an origin exists or that a remote sync succeeded.
 * Asks again each call, since setup can happen while the app is open.
 */
export async function syncedWithEpicenter(): Promise<
	Result<boolean, EpicenterSyncError>
> {
	const answer = await commands
		.syncedWithEpicenter()
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
			return cause.message;
		case 'Contract':
			return `${cause.url} is not a contract URL.`;
		case 'NotOpened':
			return `The system did not open Epicenter: ${cause.message}`;
	}
}
