/**
 * `@epicenter/folder`: `openFolder`, and `home`, the app's own place, which
 * this package chooses when it runs (ADR-0781). In a Tauri window `home` is
 * the app's data folder (ADR-0752), whose code (`data-folder.ts`) loads when
 * the folder opens; in a browser it is the account's repository for the
 * app's site (ADR-0773, ADR-0786). The `test` condition's leaf is
 * `home.memory.ts`.
 */
import { hostFromSiteUrl, repositoryName } from '@epicenter/definition/site';
import { isTauri } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
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
 * The app's own place. In a Tauri window it is the app's data folder, whose
 * `AGENTS.md` links the contract `site` publishes; it opens with no
 * account, and can be revealed in the file manager and shows its path once
 * it opened. In a browser it is `account`'s repository for `site`, which
 * opens once the account is signed in and keeps that account for the page's
 * life; a request after its sign-out is `Unavailable`. Given an account, it
 * says the account needs the app's repository (ADR-0792): the browser's
 * folder, and what a Tauri window's folder syncs with (ADR-0785). A
 * browser keeps nothing of an app (ADR-0786), so there `home` needs the
 * account.
 *
 * ```ts
 * export const folder = openFolder(todos, home({ site: APPS.TODOS.url, account }));
 * ```
 */
export function home({ site, account }: HomeOptions): Place {
	account?.need('repository');
	if (isTauri()) return dataFolder(site);
	if (!account)
		throw new TypeError(
			"A browser opens the app's repository, so home needs its account.",
		);
	return repository(account, site);
}

/** The app's data folder, its code loaded when the folder opens. */
function dataFolder(site: string): Place {
	return place((contract) => {
		let path: string | null = null;
		return {
			async open() {
				const { openDataFolder } = await import('./data-folder.js');
				const opened = await openDataFolder(contract, site);
				if (opened.error !== null) return opened;
				path = opened.data.path;
				return Ok(opened.data.store);
			},
			reveal: async () => (await import('./data-folder.js')).revealRoot('Data'),
			displayPath: () => path,
		};
	});
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
