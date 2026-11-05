/**
 * `@epicenter/folder` in a web build (the `default` leaf): `home` is this
 * browser's storage (OPFS), or, given an `account`, the account's
 * repository for the app's site (ADR-0746, ADR-0773). The desktop build's
 * leaf is `home.tauri.ts`; the `test` condition's is `home.memory.ts`.
 */
import { hostFromSiteUrl, repositoryName } from '@epicenter/definition/site';
import { Ok } from 'wellcrafted/result';
import { browserStorage } from './browser.js';
import {
	type FolderAccount,
	type HomeOptions,
	type Place,
	place,
} from './place.js';
import { repositoryStore } from './remote/store.js';

export { FolderClosed, FolderNotOpen, OpenFolderError } from './errors.js';
export type {
	Folder,
	FolderCollection,
	FolderFiles,
	FolderNotes,
	FolderState,
} from './folder.js';
export { openFolder } from './open-folder.js';
export type { Place } from './place.js';

/**
 * The app's own place: this browser's storage, or with an `account` that
 * account's repository for `site`. An app with no site (Messages) passes
 * nothing. A folder over an account opens once the
 * account is signed in, and keeps that account for the page's life; a
 * request after its sign-out is `Unavailable`.
 *
 * ```ts
 * export const folder = openFolder(todos, home({ site: APPS.TODOS.url, account }));
 * ```
 */
export function home(options?: HomeOptions): Place {
	return options?.account
		? repository(options.account, options.site)
		: browserStorage();
}

/** `account`'s repository for `site`, which opens once it has an account. */
function repository(account: FolderAccount, site: string): Place {
	const name = `~/${repositoryName(hostFromSiteUrl(site))}`;
	return place(() => ({
		open: () =>
			new Promise((resolve) => {
				const answer = (): boolean => {
					const signedIn = account.state().account;
					if (signedIn === undefined) return false;
					resolve(Ok(repositoryStore(signedIn, name)));
					return true;
				};
				if (answer()) return;
				const stop = account.subscribe(() => {
					if (answer()) stop();
				});
			}),
	}));
}
