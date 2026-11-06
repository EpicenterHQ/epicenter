/**
 * `@epicenter/folder`: `openFolder`, and `home`, the app's own place, which
 * this package chooses when it runs (ADR-0781). In a Tauri window `home` is
 * the app's data folder (ADR-0752), whose code (`data-folder.ts`) loads when
 * the folder opens; in a browser it is the folder on the server attached to
 * the app (ADR-0811). The `test` condition's leaf is `home.memory.ts`.
 */
import { isTauri } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import {
	type FolderAccount,
	type HomeOptions,
	type Place,
	place,
} from './place.js';
import { folderRepository, joinFolder } from './remote/repository.js';

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
 * it opened. In a browser it is the folder attached to the app that
 * `account` signs in as (ADR-0811): the one the person holds, or a new one
 * its first open makes; it opens once the account is signed in and keeps
 * that account for the page's life, and a request after its sign-out is
 * `Unavailable`. Given an account, it
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
	return attached(account);
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

/**
 * The folder attached to the app `account` signs in as, which opens once it
 * has an account: the one its person holds, made at its first open. With
 * several, the first; a folder of the window's own is `openFolder(view)`'s,
 * a later pass (ADR-0815).
 */
function attached(account: FolderAccount): Place {
	return place(() => ({
		async open() {
			const signedIn = await new Promise<
				NonNullable<ReturnType<FolderAccount['state']>['account']>
			>((resolve) => {
				const answer = (): boolean => {
					const now = account.state().account;
					if (now === undefined) return false;
					resolve(now);
					return true;
				};
				if (answer()) return;
				const stop = account.subscribe(() => {
					if (answer()) stop();
				});
			});
			const joined = await joinFolder(signedIn);
			if (joined.error !== null) return joined;
			const folder =
				'choose' in joined.data
					? (joined.data.choose[0] as string)
					: joined.data.folder;
			return Ok(folderRepository(signedIn, folder));
		},
	}));
}
