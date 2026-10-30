/// <reference lib="dom" />

import { asPrincipalId, PrincipalId } from '@epicenter/principal';
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
import { getProfileVia, USERINFO_PATH } from './read-profile.js';
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
	/**
	 * The token audiences this app asks for, each its own access token. The
	 * first also answers the server's own requests, such as userinfo.
	 */
	resources: readonly [string, ...string[]];
	/**
	 * Space-separated scopes. `offline_access` is refused: the client adds it
	 * itself when it needs a refresh token for its callback.
	 */
	scope: string;
	/** Expose dashboard links in account UI. */
	accountManagement: boolean;
	/** The registered redirect path on the app's origin. */
	callbackPath?: string;
	/** Holds the access tokens, shared by the origin's tabs. Defaults to `localStorage`. */
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
	/** Schedule renewal and return the function that cancels it. */
	schedule?: (callback: () => void, ms: number) => () => void;
	/** Disable timer-driven navigation for apps with work that must survive while the page stays open. */
	automaticRenewal?: boolean;
	log?: Logger;
};

const AccessToken = type({
	'+': 'delete',
	accessToken: 'string > 0',
	expiresAt: 'number',
});
type AccessToken = typeof AccessToken.infer;

/** The stored access token of each resource, and the principal userinfo named for them. */
const StoredGrant = type({
	'+': 'delete',
	tokens: { '[string]': AccessToken },
	principalId: PrincipalId,
	/** Nonsecret; a new one retires Accounts bound to the previous sign-in. */
	generation: 'string > 0',
});
type StoredGrant = typeof StoredGrant.infer;

/** One tab's pending authorization request. */
const Attempt = type({
	verifier: /^[A-Za-z0-9_-]{43}$/,
	state: 'string > 0',
	returnTo: 'string',
	createdAt: 'number',
	attachmentGeneration: 'string | null',
	accessToken: 'string | null',
});
type Attempt = typeof Attempt.infer;

const TokenResponse = type({
	access_token: 'string > 0',
	expires_in: 'number > 0',
	'refresh_token?': 'string > 0',
});

const UserInfo = type({ sub: 'string > 0' });

const BrowserOAuthDiagnostic = defineErrors({
	RenewalFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Silent access-token renewal failed.',
		cause,
	}),
	RevokeFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Token revocation failed.',
		cause,
	}),
	ListenerFailed: ({ cause }: { cause: unknown }) => ({
		message: 'An auth state listener threw.',
		cause,
	}),
});

type Attachment = {
	account: Account;
	generation: string;
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

function watchWindowStorage(onChange: () => void) {
	if (typeof window === 'undefined') return () => {};
	// Reconciling reads the one cell, so every storage event may trigger it.
	window.addEventListener('storage', onChange);
	return () => window.removeEventListener('storage', onChange);
}

/**
 * The OAuth 2.1 client of a first-party browser app (ADR-0549).
 *
 * Signs in with the authorization code grant and S256 PKCE as the app's own
 * client id, and keeps one access token per resource in one `storage` cell,
 * shared by the origin's tabs. One redirect covers every resource: the
 * callback exchanges the code for the first, and with more than one it asks
 * for `offline_access` and spends the refresh token once per other resource
 * (RFC 8707), then drops it. It keeps no refresh token: when the earliest
 * token is within ten minutes of expiry, it navigates top level to the
 * authorize endpoint with `prompt=none`, which returns a code while the
 * authorization server's session cookie lasts and `login_required` once it
 * does not.
 *
 * The tokens are read from storage on every request, so a tab uses another
 * tab's renewal. An Account survives renewal by the same person and retires
 * when storage is cleared or names another person.
 */
export function createBrowserOAuth({
	server,
	clientId,
	resources,
	scope,
	accountManagement,
	callbackPath = '/auth/callback',
	storage = globalThis.localStorage,
	attemptStorage = globalThis.sessionStorage,
	location = globalThis.location,
	watchStorage = watchWindowStorage,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	now = Date.now,
	schedule = (callback, ms) => {
		const timer = globalThis.setTimeout(callback, ms);
		return () => globalThis.clearTimeout(timer);
	},
	automaticRenewal = true,
	log = createLogger('auth/browser-oauth'),
}: CreateBrowserOAuthOptions): CallbackAuthClient {
	const { baseURL, authorityId } = server;
	const serverOrigin = new URL(baseURL).origin;
	const [primary] = resources;
	if (new Set(resources).size !== resources.length)
		throw new TypeError('Each resource is named once.');
	// Most specific first: local and self-hosted deployments serve Git at
	// `/git` on the API's own origin.
	const routes = resources
		.map((resource) => {
			const url = new URL(resource);
			return {
				resource,
				origin: url.origin,
				path: url.pathname.replace(/\/$/, ''),
			};
		})
		.sort((a, b) => b.path.length - a.path.length);
	if (
		!callbackPath.startsWith('/') ||
		callbackPath.startsWith('//') ||
		/[?#\\]/.test(callbackPath)
	)
		throw new TypeError('The callback must be an absolute local path.');
	if (scope.split(/\s+/).includes('offline_access'))
		throw new TypeError('A browser app holds no refresh token.');
	const requestedScope =
		resources.length > 1 ? `${scope} offline_access` : scope;
	const redirectUri = new URL(callbackPath, location.origin).href;
	const onCallback =
		new URL(location.href).href.split(/[?#]/)[0] === redirectUri;
	const tokenKey = `${clientId}.oauth:${serverOrigin}`;
	const attemptKey = `${clientId}.oauth-attempt:${serverOrigin}`;

	let attachment: Attachment | null = null;
	let state: AuthState = { status: 'signed-out' };
	let cancelRenewal: (() => void) | undefined;
	let completion: ReturnType<CallbackAuthClient['completeSignIn']> | undefined;
	let authorization: Promise<void> | undefined;
	let disposed = false;
	const listeners = new Set<(state: AuthState) => void>();

	/** The stored grant, or null when it is missing or corrupt. */
	function readToken(): StoredGrant | null {
		try {
			const raw = storage.getItem(tokenKey);
			if (raw === null) return null;
			const parsed = StoredGrant(JSON.parse(raw));
			return parsed instanceof type.errors ? null : parsed;
		} catch {
			return null;
		}
	}

	/** The resource whose token `target` carries, or undefined for another origin. */
	function resourceFor(target: URL): string | undefined {
		const match = routes.find(
			({ origin, path }) =>
				target.origin === origin &&
				(target.pathname === path || target.pathname.startsWith(`${path}/`)),
		);
		if (match) return match.resource;
		if (target.origin === serverOrigin) return primary;
	}

	const primaryToken = (stored: StoredGrant | null) =>
		stored?.tokens[primary]?.accessToken ?? null;

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
	function sync(): StoredGrant | null {
		if (disposed) return null;
		const stored = readToken();
		if (!stored) retire();
		else if (
			attachment?.account.principalId !== stored.principalId ||
			attachment.generation !== stored.generation
		) {
			retire();
			attachment = createAttachment(stored.principalId, stored.generation);
		} else if (
			!Object.values(stored.tokens).some(
				({ accessToken }) => accessToken === attachment?.refusedToken,
			)
		) {
			attachment.refusedToken = null;
		}
		publish();
		scheduleRenewal(stored);
		return stored;
	}

	/** The earliest expiry: every token renews together. */
	const expiresAt = (stored: StoredGrant) =>
		Math.min(...Object.values(stored.tokens).map((token) => token.expiresAt));

	const needsRenewal = (stored: StoredGrant) =>
		expiresAt(stored) - RENEW_BEFORE_MS <= now();

	function scheduleRenewal(stored: StoredGrant | null) {
		cancelRenewal?.();
		cancelRenewal = undefined;
		if (!automaticRenewal || !stored || disposed || onCallback || authorization)
			return;
		if (needsRenewal(stored)) {
			void authorizeOnce(true).catch((cause) => {
				log.error(BrowserOAuthDiagnostic.RenewalFailed({ cause }));
			});
			return;
		}
		const delay = Math.min(
			expiresAt(stored) - RENEW_BEFORE_MS - now(),
			MAX_TIMER_MS,
		);
		cancelRenewal = schedule(() => {
			cancelRenewal = undefined;
			// Another tab may have renewed while this timer waited.
			sync();
		}, delay);
	}

	function createAttachment(
		principalId: PrincipalId,
		generation: string,
	): Attachment {
		const lifetime = new AbortController();
		const accountFetch: AuthFetch = async (input, init) => {
			const target = resolveTargetUrl(input, baseURL);
			const resource =
				target && !target.username && !target.password
					? resourceFor(target)
					: undefined;
			if (!target || !resource)
				throw new TypeError(
					'Account requests must target their own server or a resource their tokens are for.',
				);
			lifetime.signal.throwIfAborted();
			const stored = sync();
			lifetime.signal.throwIfAborted();
			const accessToken = stored?.tokens[resource]?.accessToken;
			if (!accessToken || owner.refusedToken === accessToken)
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
			headers.set('authorization', `Bearer ${accessToken}`);
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
				readToken()?.tokens[resource]?.accessToken === accessToken
			) {
				owner.refusedToken = accessToken;
				publish();
			}
			return response;
		};
		const owner: Attachment = {
			account: Object.freeze({
				authorityId,
				principalId,
				baseURL,
				signal: lifetime.signal,
				fetch: accountFetch,
				getProfile: () => getProfileVia(accountFetch, baseURL),
			}),
			generation,
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
	function authorizeOnce(silent: boolean) {
		authorization ??= navigateToAuthorize(silent).catch((cause) => {
			authorization = undefined;
			throw cause;
		});
		return authorization;
	}

	async function navigateToAuthorize(silent: boolean) {
		const verifier = randomToken();
		const current = readToken();
		const attempt: Attempt = {
			verifier,
			state: randomToken(),
			returnTo: currentPath(),
			createdAt: now(),
			attachmentGeneration: current?.generation ?? null,
			accessToken: primaryToken(current),
		};
		const url = new URL('/auth/oauth2/authorize', serverOrigin);
		url.search = new URLSearchParams([
			['response_type', 'code'],
			['client_id', clientId],
			['redirect_uri', redirectUri],
			['scope', requestedScope],
			['state', attempt.state],
			['code_challenge', await challengeFor(verifier)],
			['code_challenge_method', 'S256'],
			...resources.map((resource) => ['resource', resource]),
			...(silent ? [['prompt', 'none']] : []),
		]).toString();
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

	async function revoke(
		token: string,
		hint: 'access_token' | 'refresh_token' = 'access_token',
	) {
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
						token_type_hint: hint,
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

	/**
	 * One token request. It never sends `scope`: the provider stores a
	 * narrowed scope on the rotated refresh token, shrinking the grant.
	 */
	async function requestToken(form: Record<string, string>) {
		const response = await fetchImpl(
			new URL('/auth/oauth2/token', serverOrigin),
			{
				method: 'POST',
				credentials: 'omit',
				redirect: 'error',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(form),
			},
		);
		if (!response.ok)
			throw new Error(`The token request failed (${response.status}).`);
		return TokenResponse.assert(await response.json());
	}

	/**
	 * Exchange the code for the first resource, then spend the refresh token
	 * once for each other resource, carrying the rotated one forward into
	 * `issued` so a failure can revoke all of it.
	 */
	async function issueTokens(
		code: string,
		verifier: string,
		issued: { tokens: Record<string, AccessToken>; refreshToken?: string },
	) {
		const issuedAt = now();
		const keep = (resource: string, response: typeof TokenResponse.infer) => {
			issued.tokens[resource] = {
				accessToken: response.access_token,
				expiresAt: issuedAt + response.expires_in * 1000,
			};
			issued.refreshToken = response.refresh_token;
		};
		keep(
			primary,
			await requestToken({
				grant_type: 'authorization_code',
				client_id: clientId,
				code,
				code_verifier: verifier,
				redirect_uri: redirectUri,
				resource: primary,
			}),
		);
		for (const resource of resources.slice(1)) {
			if (!issued.refreshToken)
				throw new Error('The token response carries no refresh token.');
			keep(
				resource,
				await requestToken({
					grant_type: 'refresh_token',
					client_id: clientId,
					refresh_token: issued.refreshToken,
					resource,
				}),
			);
		}
	}

	async function readPrincipal(accessToken: string) {
		const response = await fetchImpl(new URL(USERINFO_PATH, serverOrigin), {
			credentials: 'omit',
			redirect: 'error',
			headers: { authorization: `Bearer ${accessToken}` },
		});
		if (!response.ok)
			throw new Error(`The userinfo request failed (${response.status}).`);
		return asPrincipalId(UserInfo.assert(await response.json()).sub);
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
				// session. A newer token or sign-in from another tab survives it.
				const current = readToken();
				if (
					(current?.generation ?? null) === attempt.attachmentGeneration &&
					primaryToken(current) === attempt.accessToken
				)
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
			// Any failure from here revokes everything issued: a partial
			// sign-in is worse than none. On success the last refresh token is
			// dropped, not revoked: revoking it would delete the access tokens
			// rotation linked to it, and the grant ends with the session anyway.
			const issued: {
				tokens: Record<string, AccessToken>;
				refreshToken?: string;
			} = { tokens: {} };
			let stored: StoredGrant;
			try {
				await issueTokens(code, attempt.verifier, issued);
				const principalId = await readPrincipal(
					issued.tokens[primary]!.accessToken,
				);
				const current = readToken();
				if ((current?.generation ?? null) !== attempt.attachmentGeneration)
					throw new Error('The account changed during sign-in.');
				stored = {
					tokens: issued.tokens,
					principalId,
					generation:
						current?.principalId === principalId
							? current.generation
							: randomToken(),
				};
			} catch (cause) {
				for (const { accessToken } of Object.values(issued.tokens))
					void revoke(accessToken);
				if (issued.refreshToken)
					void revoke(issued.refreshToken, 'refresh_token');
				throw cause;
			}
			storage.setItem(tokenKey, JSON.stringify(stored));
			sync();
			return Ok({ returnTo });
		} catch (cause) {
			return AuthError.CompleteSignInFailed({ cause });
		}
	}

	const unwatch = watchStorage(sync);
	sync();

	return {
		getState: () => state,
		async refresh() {
			sync();
		},
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
				await authorizeOnce(false);
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
			if (stored)
				await Promise.all(
					Object.values(stored.tokens).map(({ accessToken }) =>
						revoke(accessToken),
					),
				);
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
			cancelRenewal?.();
			cancelRenewal = undefined;
			unwatch();
			retire();
			publish();
			listeners.clear();
		},
	};
}
