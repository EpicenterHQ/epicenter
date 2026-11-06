/**
 * Sign-in with Epicenter in a Tauri window: an `AuthClient` over the native
 * shell's account commands (`epicenter-account`,
 * `packages/tauri-epicenter-account`), which `connectAccount` makes there.
 *
 * The shell holds the sign-in: it signs in through the system browser,
 * keeps the refresh token in the app's credentials file (ADR-0740), reads
 * it when a request needs a token, and sends each of the account's requests
 * to Epicenter's API with a token this page never sees (`account_fetch`).
 * So the account's `fetch` here is a relay (`relay.ts`, loaded with the
 * first request), and every component reads `auth` the same way as in a
 * browser.
 *
 * Who is signed in is a setting the shell writes (`account.json` in this
 * computer's settings, ADR-0778): its origin, the principal, and whether the
 * server refused the sign-in. The page reads it at once once the settings
 * connected (`<WhenOpen>`), so it never shows a signed-in person as signed
 * out while it asks. This module is the small desktop part a browser's first
 * load carries (ADR-0781): it reads a setting and asks the shell only when
 * the person acts.
 */
import { type SettingsFile, settings } from '@epicenter/local';
import { Channel, invoke } from '@tauri-apps/api/core';
import { Ok } from 'wellcrafted/result';
import type {
	Account,
	AuthClient,
	AuthFetch,
	AuthState,
} from './auth-contract.js';
import { AccountUnavailable, AuthError } from './auth-errors.js';
import { Principal } from './auth-types.js';
import { getProfileVia } from './read-profile.js';

/** What a page needs of the native shell to reach its commands; tests stand in for it. */
export type TauriShell = {
	invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	/** A channel that hands each message the shell sends to `onMessage`. */
	channel(onMessage: (message: unknown) => void): unknown;
};

export const tauriShell: TauriShell = {
	invoke: (command, args) => invoke(command, args),
	channel: (onMessage) => new Channel<unknown>(onMessage),
};

/**
 * The token audience the shell sends an account's requests with: the API's
 * (hosted models, who is signed in), or Git's (the folder routes and every
 * folder's history), which only an app that signs in for folders has
 * (`AccountApp::API_AND_FOLDERS` in `epicenter-account`).
 */
export type TauriAudience = 'api' | 'git';

/** `account.json`, the identity the shell writes: who is signed in, and whether the server ended it. */
type Identity = {
	origin: string;
	principalId: string | null;
	/** The server ended the sign-in; only signing in again helps. */
	refused: boolean;
};
type SignedIn = { origin: string; principalId: string };

/** The identity in `text`, or signed out for none, or for a file that does not read. */
function identityIn(text: string | null): Identity | null {
	if (text === null) return null;
	try {
		const value = JSON.parse(text) as Partial<Identity>;
		if (typeof value.origin !== 'string') return null;
		return {
			origin: value.origin,
			principalId:
				typeof value.principalId === 'string' ? value.principalId : null,
			refused: value.refused === true,
		};
	} catch {
		return null;
	}
}

/**
 * A Tauri window's `AuthClient` over the shell's account commands and the
 * identity it writes (`account.json` in this computer's settings). Its reads
 * answer once the settings connected; before, they throw `SettingsNotOpen`.
 * Its account's requests carry the token for `audience`: the API's unless
 * an app that signs in for folders asks for Git's.
 */
export function createTauriAuth({
	shell = tauriShell,
	identity = settings.file('account.json'),
	audience = 'api',
}: {
	shell?: TauriShell;
	/** Where the shell writes who is signed in; tests stand in for it. */
	identity?: SettingsFile;
	audience?: TauriAudience;
} = {}): AuthClient {
	let state: AuthState = { status: 'signed-out' };
	let read: string | null | undefined;
	let current: { account: Account; lifetime: AbortController } | undefined;
	const listeners = new Set<() => void>();

	function retire() {
		current?.lifetime.abort(
			AccountUnavailable({ code: 'reauth-required' }).error,
		);
		current = undefined;
	}

	/** The Account for `signedIn`, kept while it is the same person at the same origin. */
	function accountFor(signedIn: SignedIn): Account {
		const principalId = Principal.assert({ id: signedIn.principalId }).id;
		const kept = current?.account;
		if (kept?.principalId === principalId && kept.baseURL === signedIn.origin)
			return kept;
		retire();
		const lifetime = new AbortController();
		const fetch: AuthFetch = async (input, init) =>
			(await import('./relay.js')).relayFetch(
				shell,
				signedIn.origin,
				lifetime.signal,
				() => {
					// The shell rewrites `account.json` when the server refuses the sign-in.
				},
				audience,
			)(input, init);
		const opened: Account = {
			authorityId: signedIn.origin,
			principalId,
			baseURL: signedIn.origin,
			signal: lifetime.signal,
			fetch,
			getProfile: () => getProfileVia(fetch, signedIn.origin),
		};
		current = { account: opened, lifetime };
		return opened;
	}

	/** The state `account.json` says now, kept the same object while it says the same. */
	function now(): AuthState {
		const text = identity.text();
		if (text === read) return state;
		read = text;
		const known = identityIn(text);
		if (known?.principalId) {
			const account = accountFor({
				origin: known.origin,
				principalId: known.principalId,
			});
			state = {
				status: known.refused ? 'reauth-required' : 'signed-in',
				account,
			};
		} else {
			retire();
			state = { status: 'signed-out' };
		}
		return state;
	}

	const stop = identity.subscribe(() => {
		for (const listener of [...listeners]) listener();
	});

	return {
		state: now,
		/** The shell writes who is signed in; the page reads it as it changes. */
		async refresh() {},
		get baseURL() {
			return identityIn(identity.text())?.origin ?? '';
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async startSignIn() {
			try {
				await shell.invoke<SignedIn>('account_sign_in');
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				await shell.invoke('account_sign_out');
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
			return Ok(undefined);
		},
		async getProfile() {
			const known = now();
			if (known.status === 'signed-out')
				return AuthError.ProfileUnavailable({ cause: 'signed out' });
			return known.account.getProfile();
		},
		[Symbol.dispose]() {
			stop();
			listeners.clear();
		},
	} satisfies AuthClient;
}
