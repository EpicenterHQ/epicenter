/// <reference lib="dom" />

import { PrincipalId } from '@epicenter/principal';
import { type } from 'arktype';
import { defineErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { createAccountManagementUrl } from './account-management.js';
import type {
	Account,
	AuthFetch,
	AuthState,
	CallbackAuthClient,
} from './auth-contract.js';
import { AccountUnavailable, AuthError } from './auth-errors.js';
import type { AuthServer } from './auth-server.js';
import { getProfileVia } from './read-api-session.js';
import { resolveTargetUrl } from './resolve-target-url.js';

/** Renew a stored access token this long before it expires (ADR-0549). */
const RENEW_BEFORE_MS = 10 * 60_000;
/** A sign-in attempt older than this cannot be completed. */
const ATTEMPT_MAX_AGE_MS = 10 * 60_000;
/** Sign-out waits this long for revocation before giving up on it. */
const REVOKE_TIMEOUT_MS = 5_000;
/** The longest delay `setTimeout` keeps without overflowing to zero. */
const MAX_TIMER_MS = 2 ** 31 - 1;

type SyncStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The parts of `window.location` the client reads and navigates with. */
export type BrowserOAuthLocation = {
	readonly href: string;
	readonly origin: string;
	assign(url: string): void;
	replace(url: string): void;
};

export type CreateBrowserOAuthOptions = {
	/** The deployment's authorization server and local-data authority. */
	server: AuthServer;
	/** The app's own pre-registered public client id, e.g. `so.epicenter.todos`. */
	clientId: string;
	/** The one token audience this app asks for. */
	resource: string;
	/** Space-separated scopes. `offline_access` is refused: a browser holds no refresh token. */
	scope: string;
	/** Expose dashboard links in account UI. */
	accountManagement: boolean;
	/** The registered redirect path on the app's origin. */
	callbackPath?: string;
	/** Holds the access token, shared by the origin's tabs. Defaults to `localStorage`. */
	storage?: SyncStorage;
	/** Holds one tab's PKCE attempt. Defaults to `sessionStorage`. */
	attemptStorage?: SyncStorage;
	/** Defaults to `window.location`. */
	location?: BrowserOAuthLocation;
	/**
	 * Calls `onChange` when another tab changes `storage`. Defaults to the
	 * window's `storage` event when a window exists.
	 */
	watchStorage?: (onChange: () => void) => () => void;
	fetch?: AuthFetch;
	now?: () => number;
	setTimeout?: (callback: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	log?: Logger;
};

/** The stored access token and the principal userinfo named for it. */
const StoredToken = type({
	'+': 'delete',
	accessToken: 'string > 0',
	expiresAt: 'number',
	principalId: PrincipalId,
});
type StoredToken = typeof StoredToken.infer;

/** One tab's pending authorization request. */
const Attempt = type({
	verifier: /^[A-Za-z0-9_-]{43}$/,
	state: 'string > 0',
	returnTo: 'string',
	createdAt: 'number',
});
type Attempt = typeof Attempt.infer;

const TokenResponse = type({
	access_token: 'string > 0',
	expires_in: 'number > 0',
});

const UserInfo = type({ sub: 'string > 0' });

const BrowserOAuthDiagnostic = defineErrors({
	RevokeFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Access token revocation failed.',
		cause,
	}),
	ListenerFailed: ({ cause }: { cause: unknown }) => ({
		message: 'An auth state listener threw.',
		cause,
	}),
});

type Attachment = {
	account: Account;
	lifetime: AbortController;
	/** The token the server refused, while the Account waits for a new one. */
	refusedToken: string | null;
};

function base64url(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function challengeFor(verifier: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(verifier),
	);
	return base64url(new Uint8Array(digest));
}

function defaultWatchStorage() {
	return (onChange: () => void) => {
		if (typeof window === 'undefined') return () => {};
		// Reconciling reads the one cell, so every storage event may trigger it.
		const listener = () => onChange();
		window.addEventListener('storage', listener);
		return () => window.removeEventListener('storage', listener);
	};
}

/**
 * The OAuth 2.1 client of a first-party browser app (ADR-0549).
 *
 * Signs in with the authorization code grant and S256 PKCE as the app's own
 * client id, and keeps one access token in `storage`, shared by the origin's
 * tabs. It holds no refresh token: when the token is within ten minutes of
 * expiry, it navigates top level to the authorize endpoint with
 * `prompt=none`, which returns a code while the authorization server's session
 * cookie lasts and `login_required` once it does not.
 *
 * The token is read from storage on every request, so a tab uses another
 * tab's renewal. An Account survives renewal by the same person and retires
 * when storage is cleared or names another person.
 */
export function createBrowserOAuth({
	server,
	clientId,
	resource,
	scope,
	accountManagement,
	callbackPath = '/auth/callback',
	storage = globalThis.localStorage,
	attemptStorage = globalThis.sessionStorage,
	location = globalThis.location,
	watchStorage = defaultWatchStorage(),
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	now = Date.now,
	setTimeout: setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
	clearTimeout: clearTimer = (handle) =>
		globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
	log = createLogger('auth/browser-oauth'),
}: CreateBrowserOAuthOptions): CallbackAuthClient {
	const { baseURL, authorityId } = server;
	const serverOrigin = new URL(baseURL).origin;
	// The token is for `resource`, so its own origin may carry it too: on the
	// hosted cloud, Git is served from an origin of its own.
	const resourceOrigin = new URL(resource).origin;
	if (
		!callbackPath.startsWith('/') ||
		callbackPath.startsWith('//') ||
		/[?#\\]/.test(callbackPath)
	)
		throw new TypeError('The callback must be an absolute local path.');
	if (scope.split(/\s+/).includes('offline_access'))
		throw new TypeError('A browser app holds no refresh token.');
	const redirectUri = new URL(callbackPath, location.origin).href;
	const tokenKey = `${clientId}.oauth:${serverOrigin}`;
	const attemptKey = `${clientId}.oauth-attempt:${serverOrigin}`;

	let attachment: Attachment | null = null;
	let state: AuthState = { status: 'signed-out' };
	let renewalTimer: unknown;
	let completion: ReturnType<CallbackAuthClient['completeSignIn']> | undefined;
	let disposed = false;
	const listeners = new Set<(state: AuthState) => void>();

	function readToken(): StoredToken | null {
		try {
			const raw = storage.getItem(tokenKey);
			if (raw === null) return null;
			const parsed = StoredToken(JSON.parse(raw));
			return parsed instanceof type.errors ? null : parsed;
		} catch {
			return null;
		}
	}

	function publish() {
		const next: AuthState = attachment
			? {
					status: attachment.refusedToken ? 'reauth-required' : 'signed-in',
					account: attachment.account,
				}
			: { status: 'signed-out' };
		if (next.status === state.status && next.account === state.account) return;
		state = next;
		for (const listener of listeners) {
			try {
				listener(state);
			} catch (cause) {
				log.error(BrowserOAuthDiagnostic.ListenerFailed({ cause }));
			}
		}
	}

	function retire() {
		attachment?.lifetime.abort(
			AccountUnavailable({ code: 'reauth-required' }).error,
		);
		attachment = null;
	}

	/** Reconcile the published state with storage, which another tab may have changed. */
	function sync(): StoredToken | null {
		if (disposed) return null;
		const stored = readToken();
		if (!stored) retire();
		else if (attachment?.account.principalId !== stored.principalId) {
			retire();
			attachment = createAttachment(stored.principalId);
		} else if (attachment.refusedToken !== stored.accessToken) {
			attachment.refusedToken = null;
		}
		publish();
		scheduleRenewal(stored);
		return stored;
	}

	const needsRenewal = (stored: StoredToken) =>
		stored.expiresAt - RENEW_BEFORE_MS <= now();

	function scheduleRenewal(stored: StoredToken | null) {
		if (renewalTimer !== undefined) clearTimer(renewalTimer);
		renewalTimer = undefined;
		if (!stored || disposed) return;
		const delay = Math.min(
			Math.max(stored.expiresAt - RENEW_BEFORE_MS - now(), 0),
			MAX_TIMER_MS,
		);
		renewalTimer = setTimer(() => {
			renewalTimer = undefined;
			// Another tab may have renewed while this timer waited.
			const current = sync();
			if (current && needsRenewal(current)) void navigateToAuthorize(true);
		}, delay);
	}

	function createAttachment(principalId: PrincipalId): Attachment {
		const lifetime = new AbortController();
		const accountFetch: AuthFetch = async (input, init) => {
			const target = resolveTargetUrl(input, baseURL);
			if (
				(target?.origin !== serverOrigin &&
					target?.origin !== resourceOrigin) ||
				target.username ||
				target.password
			)
				throw new TypeError(
					'Account requests must target their own server or the resource their token is for.',
				);
			lifetime.signal.throwIfAborted();
			const stored = sync();
			lifetime.signal.throwIfAborted();
			if (!stored || owner.refusedToken === stored.accessToken)
				throw AccountUnavailable({ code: 'reauth-required' }).error;
			if (init?.body instanceof ReadableStream) {
				// Bun's Request has no `keepalive`, so a caller's choice survives
				// only as an option to the underlying fetch.
				const keepalive = init.keepalive;
				input = new Request(input instanceof Request ? input : target, init);
				init = keepalive === undefined ? undefined : { keepalive };
			}
			const caller =
				init?.signal !== undefined
					? init.signal
					: input instanceof Request
						? input.signal
						: null;
			const signal = caller
				? AbortSignal.any([lifetime.signal, caller])
				: lifetime.signal;
			const headers = new Headers(
				input instanceof Request ? input.headers : undefined,
			);
			new Headers(init?.headers).forEach((value, key) => {
				headers.set(key, value);
			});
			headers.set('authorization', `Bearer ${stored.accessToken}`);
			headers.delete('cookie');
			const response = await fetchImpl(
				input instanceof Request ? input : target.href,
				{
					...init,
					headers,
					signal,
					credentials: 'omit',
					redirect: 'manual',
				},
			);
			signal.throwIfAborted();
			if (
				response.status === 401 &&
				attachment === owner &&
				readToken()?.accessToken === stored.accessToken
			) {
				owner.refusedToken = stored.accessToken;
				publish();
			}
			return response;
		};
		const owner: Attachment = {
			account: Object.freeze({
				authorityId,
				principalId,
				baseURL,
				fetch: accountFetch,
				getProfile: () => getProfileVia(accountFetch, baseURL),
			}),
			lifetime,
			refusedToken: null,
		};
		return owner;
	}

	function currentPath() {
		const url = new URL(location.href);
		return url.pathname + url.search + url.hash;
	}

	/** Save one PKCE attempt in this tab and leave for the authorize endpoint. */
	async function navigateToAuthorize(silent: boolean) {
		const verifier = randomToken();
		const attempt: Attempt = {
			verifier,
			state: randomToken(),
			returnTo: currentPath(),
			createdAt: now(),
		};
		const url = new URL('/auth/oauth2/authorize', serverOrigin);
		url.search = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: redirectUri,
			scope,
			state: attempt.state,
			code_challenge: await challengeFor(verifier),
			code_challenge_method: 'S256',
			resource,
			...(silent ? { prompt: 'none' } : {}),
		}).toString();
		if (disposed) return;
		attemptStorage.setItem(attemptKey, JSON.stringify(attempt));
		location.assign(url.href);
	}

	/** Read and remove this tab's attempt: a state is good for one callback. */
	function takeAttempt(): Attempt | null {
		try {
			const raw = attemptStorage.getItem(attemptKey);
			attemptStorage.removeItem(attemptKey);
			if (raw === null) return null;
			const parsed = Attempt(JSON.parse(raw));
			return parsed instanceof type.errors ? null : parsed;
		} catch {
			return null;
		}
	}

	/** A same-origin path, or nothing; never an open redirect. */
	function safeReturnTo(returnTo: string): string | undefined {
		if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return;
		const url = new URL(returnTo, location.origin);
		if (url.origin !== location.origin) return;
		if (url.href.split(/[?#]/)[0] === redirectUri) return;
		return returnTo;
	}

	async function revoke(token: string) {
		try {
			const response = await fetchImpl(
				new URL('/auth/oauth2/revoke', serverOrigin),
				{
					method: 'POST',
					credentials: 'omit',
					redirect: 'error',
					signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						token,
						client_id: clientId,
						token_type_hint: 'access_token',
					}),
				},
			);
			await response.body?.cancel();
			if (!response.ok)
				throw new Error(`Revocation failed (${response.status}).`);
		} catch (cause) {
			log.error(BrowserOAuthDiagnostic.RevokeFailed({ cause }));
		}
	}

	async function exchange(code: string, verifier: string) {
		const response = await fetchImpl(
			new URL('/auth/oauth2/token', serverOrigin),
			{
				method: 'POST',
				credentials: 'omit',
				redirect: 'error',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: clientId,
					code,
					code_verifier: verifier,
					redirect_uri: redirectUri,
					resource,
				}),
			},
		);
		if (!response.ok)
			throw new Error(`The token request failed (${response.status}).`);
		return TokenResponse.assert(await response.json());
	}

	async function readPrincipal(accessToken: string) {
		const response = await fetchImpl(
			new URL('/auth/oauth2/userinfo', serverOrigin),
			{
				credentials: 'omit',
				redirect: 'error',
				headers: { authorization: `Bearer ${accessToken}` },
			},
		);
		if (!response.ok)
			throw new Error(`The userinfo request failed (${response.status}).`);
		return UserInfo.assert(await response.json()).sub as PrincipalId;
	}

	async function complete(): ReturnType<CallbackAuthClient['completeSignIn']> {
		try {
			const url = new URL(location.href);
			const params = url.searchParams;
			const attempt = takeAttempt();
			if (
				!attempt ||
				params.get('state') !== attempt.state ||
				now() < attempt.createdAt ||
				now() - attempt.createdAt >= ATTEMPT_MAX_AGE_MS
			)
				throw new Error(
					'The sign-in attempt is missing, expired, or does not match.',
				);
			const returnTo = safeReturnTo(attempt.returnTo);
			const error = params.get('error');
			if (error === 'login_required') {
				// The silent renewal's answer when the authorization server has no
				// session: the person is signed out, which is not a failure.
				storage.removeItem(tokenKey);
				sync();
				return Ok({ returnTo });
			}
			if (error !== null)
				throw new Error(
					`The authorization server answered ${error}${params.get('error_description') ? `: ${params.get('error_description')}` : ''}.`,
				);
			const code = params.get('code');
			if (!code) throw new Error('The callback carries no code.');
			const issuedAt = now();
			const token = await exchange(code, attempt.verifier);
			let principalId: PrincipalId;
			try {
				principalId = await readPrincipal(token.access_token);
			} catch (cause) {
				void revoke(token.access_token);
				throw cause;
			}
			const stored: StoredToken = {
				accessToken: token.access_token,
				expiresAt: issuedAt + token.expires_in * 1000,
				principalId,
			};
			storage.setItem(tokenKey, JSON.stringify(stored));
			sync();
			return Ok({ returnTo });
		} catch (cause) {
			return AuthError.CompleteSignInFailed({ cause });
		}
	}

	const unwatch = watchStorage(() => {
		sync();
	});

	const initial = sync();
	const onCallback =
		new URL(location.href).href.split(/[?#]/)[0] === redirectUri;
	// A token near expiry renews now, unless this page is the callback that is
	// about to store a new one. A person who never signed in stays signed out.
	if (initial && needsRenewal(initial) && !onCallback)
		void navigateToAuthorize(true);

	return {
		getState: () => state,
		baseURL,
		...(accountManagement
			? { accountManagementUrl: createAccountManagementUrl }
			: {}),
		onStateChange(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		async startSignIn(): Promise<Result<undefined, AuthError>> {
			// No `prompt`: the authorization server asks the person only when
			// its own session is gone, and reauthentication needs nothing more.
			try {
				if (disposed) throw new Error('Auth client disposed.');
				await navigateToAuthorize(false);
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		completeSignIn() {
			completion ??= complete();
			return completion;
		},
		async signOut() {
			const stored = readToken();
			try {
				storage.removeItem(tokenKey);
				attemptStorage.removeItem(attemptKey);
			} catch (cause) {
				retire();
				publish();
				return AuthError.SignOutFailed({ cause });
			}
			sync();
			// Best effort and bounded: a failed revocation never keeps the person
			// signed in here, and the token lapses on its own.
			if (stored) await revoke(stored.accessToken);
			return Ok(undefined);
		},
		getProfile() {
			return (
				attachment?.account.getProfile() ??
				Promise.resolve(AuthError.ProfileUnavailable({ cause: 'Signed out.' }))
			);
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			if (renewalTimer !== undefined) clearTimer(renewalTimer);
			renewalTimer = undefined;
			unwatch();
			retire();
			publish();
			listeners.clear();
		},
	};
}
