/**
 * An installed app's account on the desktop: the app's sign-in, which the
 * `epicenter` CLI holds as its desktop grant (ADR-0556, ADR-0558).
 *
 * No page holds an access token (ADR-0549's desktop row: WebViews hold
 * none). Identity and the deployment come from `status`, which reads
 * `epicenter auth status`, so the page names the deployment the shell runs
 * the CLI for and never one of its own build;
 * every account request goes out through `send`, which runs
 * `epicenter send --desktop` with an account target, so the CLI adds the
 * token for the named resource outside the page. Settings owns the app's
 * sign-in and sign-out, so `startSignIn` opens it and `signOut` refuses.
 *
 * This module binds nothing native. The app's desktop leaf supplies
 * `status`, `send`, and `openSignIn` over its shell commands
 * (`auth_status`, `account_send`, `open_home`).
 */

import { PRODUCTION_API_URL } from '@epicenter/constants/apps';
import { asPrincipalId } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import { createAccountManagementUrl } from './account-management.js';
import type {
	Account,
	AuthClient,
	AuthFetch,
	AuthState,
} from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import { epicenterCloud, selfHostedServer } from './auth-server.js';
import { getProfileVia } from './read-profile.js';
import { resolveTargetUrl } from './resolve-target-url.js';

/**
 * The deployment's resources an account request names by role (ADR-0549):
 * `api` for profile and hosted inference, `git` for Git and the repository
 * listing, `GET /api/repos`.
 */
export type DesktopAccountAudience = 'api' | 'git';

/** What `epicenter auth status` says of the desktop grant. */
export type DesktopAccountStatus = {
	/** The deployment the CLI signs in to. */
	readonly origin: string;
	/** Who the grant belongs to and its nonsecret attachment generation. */
	readonly grant: {
		readonly accountId: string;
		readonly generation: string;
	} | null;
	/** Why an existing grant cannot open an Account. */
	readonly problem?: string;
};

export type DesktopAccountAuthOptions = {
	/** Read the desktop grant. Throws when it cannot be read. */
	status: () => Promise<DesktopAccountStatus>;
	/**
	 * Send one host-permitted request with the desktop grant's
	 * token for `audience`. Resolves with the response, whatever its status;
	 * rejects when none came back, with the CLI's error name, such as
	 * `NoAccountToken` when the grant is missing or ended.
	 */
	send: (
		audience: DesktopAccountAudience,
		generation: string,
		request: Request,
	) => Promise<Response>;
	/** Show the person where the app signs in: Settings. */
	openSignIn: () => Promise<void>;
	/** The resource `Account.fetch` carries a token for. */
	audience: DesktopAccountAudience;
	/**
	 * Call `refresh` whenever the grant may have changed under the page, such
	 * as when the window regains focus after the person signed in from
	 * Settings. Returns the unsubscribe. Defaults to the window's focus.
	 */
	watch?: (refresh: () => void) => () => void;
};

export type DesktopAccountAuth = AuthClient & {
	readonly problem: string | undefined;
};

const SIGN_OUT_FROM_SETTINGS =
	"This app uses the account Epicenter is signed in to. Sign out from Epicenter's Settings.";

function watchFocus(refresh: () => void): () => void {
	if (typeof window === 'undefined') return () => {};
	window.addEventListener('focus', refresh);
	return () => window.removeEventListener('focus', refresh);
}

/** The app's account through the CLI's desktop grant; see the module doc. */
export function createDesktopAccountAuth({
	status,
	send,
	openSignIn,
	audience,
	watch = watchFocus,
}: DesktopAccountAuthOptions): DesktopAccountAuth {
	const listeners = new Set<(state: AuthState) => void>();
	let state: AuthState = { status: 'signed-out' };
	/** The deployment `status` last named; empty until the first read. */
	let baseURL = '';
	let problem: string | undefined;
	/** The grant the current account was opened for, so a new sign-in opens a new one. */
	let grantKey: string | undefined;
	let readSequence = 0;
	let latestRefresh: Promise<void> | undefined;
	let lifetime = new AbortController();
	let disposed = false;

	function publish(next: AuthState) {
		if (state.status === next.status && state.account === next.account) return;
		state = next;
		for (const listener of listeners) listener(state);
	}

	function retire() {
		lifetime.abort();
		lifetime = new AbortController();
		grantKey = undefined;
	}

	function openAccount(
		origin: string,
		accountId: string,
		generation: string,
	): Account {
		const { signal } = lifetime;
		// Any deployment but the hosted one is a self-hosted server, which
		// names its local data by its origin.
		const descriptor =
			origin === PRODUCTION_API_URL
				? epicenterCloud(origin)
				: selfHostedServer(origin);
		const via =
			(resource: DesktopAccountAudience): AuthFetch =>
			async (input, init) => {
				signal.throwIfAborted();
				const target = resolveTargetUrl(input, origin);
				if (target?.origin !== origin)
					throw new TypeError('Account requests must target their own server.');
				const callerSignal =
					init?.signal ?? (input instanceof Request ? input.signal : undefined);
				const request = new Request(input instanceof Request ? input : target, {
					...init,
					signal: callerSignal
						? AbortSignal.any([signal, callerSignal])
						: signal,
				});
				// The CLI adds the token; nothing the page set stands in for it.
				request.headers.delete('authorization');
				request.headers.delete('cookie');
				let response: Response;
				try {
					response = await send(resource, generation, request);
				} catch (cause) {
					// A grant that is missing or ended answers no token; read the
					// grant again so the page learns which.
					if (
						typeof cause === 'object' &&
						cause !== null &&
						'name' in cause &&
						(cause.name === 'NoAccountToken' || cause.name === 'GrantChanged')
					)
						refreshWithoutCaller();
					throw cause;
				}
				signal.throwIfAborted();
				if (response.status === 401 && state.account === account)
					publish({ status: 'reauth-required', account });
				return response;
			};
		const account: Account = Object.freeze({
			authorityId: descriptor.authorityId,
			principalId: asPrincipalId(accountId),
			baseURL: origin,
			fetch: via(audience),
			getProfile: () => getProfileVia(via('api'), origin),
		});
		return account;
	}

	function refresh(): Promise<void> {
		if (disposed) return Promise.resolve();
		const sequence = ++readSequence;
		const pending = (async () => {
			let read: DesktopAccountStatus;
			try {
				read = await status();
			} catch (cause) {
				// Keep the last Account, but tell an explicit reader why this read failed.
				throw cause;
			}
			if (disposed) return;
			if (sequence !== readSequence) {
				// A caller awaiting this read needs the newer result too.
				await latestRefresh;
				return;
			}
			const origin = new URL(read.origin).origin;
			baseURL = origin;
			problem = read.problem;
			if (read.grant === null) {
				retire();
				publish({ status: 'signed-out' });
				return;
			}
			const key = JSON.stringify([
				origin,
				read.grant.accountId,
				read.grant.generation,
			]);
			if (key === grantKey && state.account !== undefined) return;
			retire();
			grantKey = key;
			publish({
				status: 'signed-in',
				account: openAccount(origin, read.grant.accountId, read.grant.generation),
			});
		})();
		latestRefresh = pending;
		return pending;
	}

	function refreshWithoutCaller() {
		void refresh().catch(() => {
			// The next explicit read can report a status failure.
		});
	}

	const unwatch = watch(refreshWithoutCaller);

	return {
		getState() {
			return state;
		},
		/** The deployment `status` last named; empty until the first read. */
		get baseURL() {
			return baseURL;
		},
		get problem() {
			return problem;
		},
		/** Only the hosted deployment has the account website. */
		get accountManagementUrl() {
			return baseURL === PRODUCTION_API_URL
				? createAccountManagementUrl
				: undefined;
		},
		onStateChange(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		async startSignIn() {
			try {
				await openSignIn();
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			return AuthError.SignOutFailed({ cause: SIGN_OUT_FROM_SETTINGS });
		},
		getProfile() {
			return (
				state.account?.getProfile() ??
				Promise.resolve(AuthError.ProfileUnavailable({ cause: 'Signed out.' }))
			);
		},
		refresh,
		[Symbol.dispose]() {
			disposed = true;
			unwatch();
			lifetime.abort();
			listeners.clear();
		},
	};
}
