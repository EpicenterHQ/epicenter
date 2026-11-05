/**
 * `@epicenter/folder` in a web build (the `default` leaf): `openFolder`
 * opens this browser's private storage (OPFS), or, given an `account`, the
 * account's copy in its Epicenter repository (ADR-0746, ADR-0766). The
 * desktop build's leaf is `open-folder.tauri.ts`; the `test` condition's is
 * `open-folder.memory.ts`.
 */
import type { Contract } from '@epicenter/definition/contract';
import { hostFromSiteUrl, repositoryName } from '@epicenter/definition/site';
import { Ok } from 'wellcrafted/result';
import { closeDevice, holdOpening, openDevice } from './browser.js';
import { createDeviceClient } from './device/client.js';
import {
	createFolder,
	type FolderAccount,
	type FolderOpen,
	type OpenFolder,
} from './folder.js';
import { repositoryStore } from './remote/store.js';

export { OpenFolderError } from './errors.js';
export type {
	Folder,
	FolderAccount,
	FolderCollection,
	FolderFiles,
	FolderNotes,
	FolderState,
	OpenFolderOptions,
} from './folder.js';

/**
 * The app's folder, opening at once: this browser's storage, or with
 * `{ site, account }` the account's repository for the site. A folder over
 * an account opens once the account is signed in, and keeps that account
 * for the page's life; a request after its sign-out is `Unavailable`. A
 * contract that is not well formed throws.
 *
 * ```ts
 * export const folder = openFolder(todos, { site: APPS.TODOS.url, account });
 * ```
 */
export const openFolder: OpenFolder = (contract, options) => {
	if (!options?.account) {
		let opening: ReturnType<typeof openDevice<typeof contract>> | undefined;
		const folder = createFolder(
			contract,
			() => {
				opening = openDevice(contract);
				return opening;
			},
			{ close: (client) => closeDevice(client) },
		);
		// What a recording appends to as it records (`filesOf`).
		holdOpening(folder, () => opening);
		return folder;
	}
	return createFolder(
		contract,
		accountCopy(contract, options.account, options.site),
	);
};

/** The open of `account`'s repository for `site`: once it has an account. */
function accountCopy<TContract extends Contract>(
	contract: TContract,
	account: FolderAccount,
	site: string,
): FolderOpen<TContract> {
	const repository = `~/${repositoryName(hostFromSiteUrl(site))}`;
	return () =>
		new Promise((resolve) => {
			const answer = (): boolean => {
				const signedIn = account.state().account;
				if (signedIn === undefined) return false;
				resolve(
					Ok(
						createDeviceClient(contract, repositoryStore(signedIn, repository)),
					),
				);
				return true;
			};
			if (answer()) return;
			const stop = account.subscribe(() => {
				if (answer()) stop();
			});
		});
}
