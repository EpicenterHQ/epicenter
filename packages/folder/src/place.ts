/**
 * Where a folder is, as a value (ADR-0773): the app's `home`, a
 * `directory` in Bun or Node, or `memory` under the `test` condition. A
 * place is opaque: only this package makes one, and `openFolder` opens it.
 * Every place opens to a store (`Store`), and the one typed client
 * gives the folder the contract's notes and files over it.
 */
import type { Contract } from '@epicenter/definition/contract';
import type { Result } from 'wellcrafted/result';
import type { Store, Unavailable } from './device/store.js';
import type { OpenFolderError, RevealRootError } from './errors.js';

const OPENING = Symbol('epicenter.place');

/** What a place gives the folder opened at it. */
export type Opening = {
	/**
	 * Open the place's store: called when the folder opens, again after a
	 * temporary failure (`Unavailable`, which the folder retries on its own),
	 * and on each retry after a failure that waiting will not fix.
	 */
	open(): Promise<Result<Store, OpenFolderError | Unavailable>>;
	/** Show the place in the file manager, even when it did not open: only the desktop's data folder has one. */
	reveal?: () => Promise<Result<null, RevealRootError>>;
	/** Where the place is, to show a person, once it opened: only the desktop's data folder has one. */
	displayPath?: () => string | null;
};

/** Where a folder is: a value `openFolder` opens, which only this package makes. */
export type Place = {
	readonly [OPENING]: (contract: Contract) => Opening;
};

/** A place that opens, for each folder opened at it, as `opening` says for its contract. */
export function place(opening: (contract: Contract) => Opening): Place {
	return { [OPENING]: opening };
}

/** How `at` opens for a folder of `contract`. */
export function openingOf(at: Place, contract: Contract): Opening {
	return at[OPENING](contract);
}

/**
 * What `home` takes. `site` is the app's production site: in a Tauri window
 * the data folder's `AGENTS.md` links its published contract, and in a
 * browser it names the account's repository. `account` is that
 * repository's, which a browser needs; the data folder opens without one.
 */
export type HomeOptions = {
	site: string;
	/** The account whose repository a browser opens; a Tauri window's folder opens without one. */
	account?: FolderAccount | null;
};

/**
 * The account a web folder opens the repository of: any
 * `@epicenter/account` auth client. The folder opens once it has an
 * account, and keeps that account for its life; a new account is a new
 * page.
 */
export type FolderAccount = {
	/** Say the folder needs the app's repository, which sign-in then asks for (ADR-0792). */
	need(need: 'repository'): void;
	state(): {
		account?:
			| {
					readonly baseURL: string;
					readonly signal: AbortSignal;
					fetch(
						input: Request | string | URL,
						init?: RequestInit,
					): Promise<Response>;
			  }
			| undefined;
	};
	subscribe(listener: () => void): () => void;
};
