import type { AuthIdentityState } from './auth-identity-state.js';
/// <reference lib="dom" />

import { API_ROUTES } from '@epicenter/constants/api-routes';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { AuthControls, AuthFetch } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import { ApiSessionResponse } from './auth-types.js';

/**
 * Construction inputs for the same-origin cookie auth client.
 *
 * Only `baseURL` is required. `fetch` and `navigate` exist so tests can drive
 * the client without a DOM (and so the browser defaults bind correctly);
 * `callbackURL` lets a caller override where the hosted sign-in returns.
 */
export type CreateSameOriginCookieAuthConfig = {
	/**
	 * Same-origin API base URL. For a browser app the API itself serves (the
	 * dashboard at `api.epicenter.so/dashboard`), this is `window.location.origin`.
	 */
	baseURL: string;
	/**
	 * Relative path the hosted sign-in returns to once the cookie is set. The
	 * page only honors a path starting with `/`. Defaults to the current
	 * `location.pathname`.
	 */
	callbackURL?: string;
	/**
	 * Fetch implementation. The browser default is bound to `globalThis` because
	 * an unbound `fetch` throws "Illegal invocation".
	 */
	fetch?: AuthFetch;
	/**
	 * Browser navigation used by `startSignIn`. Defaults to `location.assign`.
	 */
	navigate?: (url: string) => void;
};

const SIGN_IN_PATH = '/sign-in';
const SIGN_OUT_PATH = '/auth/sign-out';

const SameOriginAuthError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: 'Auth state subscriber threw.',
		cause,
	}),
});

/**
 * Auth client for a browser app served from the SAME ORIGIN as the API (the
 * billing dashboard at `api.epicenter.so/dashboard`).
 *
 * After Google sign-in such an app already holds a first-party Better Auth
 * session cookie, so running PKCE against its own origin to mint a bearer is
 * redundant (and mints an `offline_access` refresh token it never uses). This
 * client uses the cookie directly:
 *
 *   - resource calls go out same-origin with `credentials: 'include'` and no
 *     `Authorization` header; `requireCookieOrBearerPrincipal` resolves the
 *     principal from the cookie and `requireOriginForCookieMutations` guards CSRF.
 *   - `startSignIn` navigates to the hosted `/sign-in` page (Google sign-in sets
 *     the cookie), then returns to `callbackURL`.
 *   - `signOut` hits Better Auth's `/auth/sign-out`.
 *
 * There is no OAuth grant, refresh token, or persisted cell: the browser owns
 * the cookie. Because the httpOnly cookie is invisible to JS, the client cannot
 * know synchronously whether it is signed in; it reads `/api/session` once at
 * construction to confirm, and that response also supplies the `principalId`
 * the public `AuthIdentityState` carries.
 *
 * **So `state` reports `signed-out` for the first round trip after load, and a
 * gate on this client renders its signed-out screen for that long even for
 * somebody who is signed in.** `AuthIdentityState` has no arm for "not known yet", and
 * it is not given one for this: three of the four clients read their identity
 * synchronously (a persisted grant, or the desktop bootstrap element), so a
 * fourth arm would force a branch on every gate in the repository for a state
 * they can never be in. `apps/api/ui` is the only consumer, it opens no store,
 * and it accepts the flash. When a reload gate existed, this was also why this
 * client could not mount one: the confirmation is a principal change, so the
 * gate would reload into another optimistic boot and loop
 * (`refusal-is-not-an-identity-change.test.ts`). The gate is gone and the
 * invariant is not: a keyed session would remount on the same flip.
 *
 * This is the cookie-credential sibling of {@link createOAuthAppAuth}, not a
 * mode flag on it: the two are different credential models. Cross-origin and
 * native clients (web app, extension, Tauri, CLI) keep using `createOAuthAppAuth`
 * and PKCE.
 *
 * Its HTTP requests use the ambient cookie. It offers no account-bound data transport.
 */
export function createSameOriginCookieAuth({
	baseURL,
	callbackURL,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	navigate = (url) => globalThis.location.assign(url),
}: CreateSameOriginCookieAuthConfig): AuthControls<AuthIdentityState> & {
	fetch: AuthFetch;
} {
	const log = createLogger('auth/same-origin-cookie');
	let state: AuthIdentityState = { status: 'signed-out' };
	const listeners = new Set<(state: AuthIdentityState) => void>();

	function setState(next: AuthIdentityState) {
		state = next;
		for (const listener of listeners) {
			try {
				listener(next);
			} catch (cause) {
				log.error(SameOriginAuthError.SubscriberThrew({ cause }));
			}
		}
	}

	/**
	 * Drop to signed-out when an already-signed-in client sees a 401: the cookie
	 * is gone or expired. Shared by `fetch` (arbitrary resource calls) and
	 * `getProfile`. This client has no `reauth-required` arm: re-auth is the same
	 * hosted sign-in as a fresh login.
	 */
	function reflectSignedOutOn401(status: number | null) {
		if (status === 401 && state.status === 'signed-in') {
			setState({ status: 'signed-out' });
		}
	}

	/**
	 * Read `/api/session` with the cookie. The one request+parse the two session
	 * readers share: `confirmSession` projects it into `state` at boot,
	 * `getProfile` projects it into the profile contract on demand. A transport or
	 * parse failure reports `status: null` (and any thrown `cause`); an HTTP
	 * failure reports its status, so each caller applies its own signed-out
	 * reaction and error mapping.
	 */
	async function readCookieSession(): Promise<
		| { ok: true; session: ApiSessionResponse }
		| { ok: false; status: number | null; cause?: unknown }
	> {
		let response: Response;
		try {
			response = await fetchImpl(API_ROUTES.session.url(baseURL), {
				credentials: 'include',
			});
		} catch (cause) {
			return { ok: false, status: null, cause };
		}
		if (!response.ok) return { ok: false, status: response.status };
		try {
			const session = ApiSessionResponse.assert(await response.json());
			return { ok: true, session };
		} catch (cause) {
			return { ok: false, status: null, cause };
		}
	}

	/**
	 * Confirm the session at boot. A 401/403 is signed-out; a 200 installs
	 * `signed-in` with the response's principal id. Network or parse failures
	 * leave the current state, so an offline load keeps the last known projection.
	 */
	async function confirmSession() {
		const read = await readCookieSession();
		if (read.ok) {
			setState({ status: 'signed-in', principalId: read.session.principalId });
			return;
		}
		if (read.status === 401 || read.status === 403) {
			setState({ status: 'signed-out' });
		}
	}

	void confirmSession();

	return {
		get state() {
			return state;
		},
		// Served same-origin by the server it signs into; its one consumer is the
		// hosted dashboard.
		connection: {
			baseURL,
			get status() {
				return 'connected' as const;
			},
			onChange() {
				return () => undefined;
			},
		},
		onStateChange(fn: (state: AuthIdentityState) => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		async startSignIn() {
			const target = callbackURL ?? globalThis.location.pathname;
			navigate(
				`${baseURL}${SIGN_IN_PATH}?callbackURL=${encodeURIComponent(target)}`,
			);
			return Ok(undefined);
		},
		async signOut() {
			const { error } = await tryAsync({
				try: () =>
					fetchImpl(`${baseURL}${SIGN_OUT_PATH}`, {
						method: 'POST',
						credentials: 'include',
					}),
				catch: (cause) => AuthError.SignOutFailed({ cause }),
			});
			// Local sign-out must not depend on the network call succeeding.
			setState({ status: 'signed-out' });
			return error ? Err(error) : Ok(undefined);
		},
		async fetch(input: Request | string | URL, init?: RequestInit) {
			const target =
				typeof input === 'string' && input.startsWith('/')
					? new URL(input, baseURL).toString()
					: input;
			const response = await fetchImpl(target, {
				...init,
				credentials: 'include',
			});
			reflectSignedOutOn401(response.status);
			return response;
		},
		async getProfile() {
			const read = await readCookieSession();
			if (read.ok) {
				return Ok({ id: read.session.principalId, email: read.session.email });
			}
			reflectSignedOutOn401(read.status);
			return AuthError.ProfileUnavailable({
				cause: read.cause ?? {
					message: `${API_ROUTES.session.pattern} failed with ${read.status}.`,
					status: read.status,
				},
			});
		},
		[Symbol.dispose]() {
			listeners.clear();
		},
	};
}
