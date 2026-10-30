/**
 * The authorization server's own pages hold no access token. They use its
 * HttpOnly, host-only Better Auth session cookie on the same origin
 * (ADR-0549). This client reads that cookie session and hands the dashboard
 * one Account per signed-in person.
 */

import {
	type Account,
	type AuthClient,
	AuthError,
	type AuthFetch,
	type AuthState,
	Principal,
} from '@epicenter/auth';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

/** Better Auth's `get-session` answer, reduced to what this client reads. */
async function readSessionPrincipal(
	fetchImpl: AuthFetch,
	origin: string,
): Promise<Principal | null> {
	const response = await fetchImpl(
		new URL('/auth/get-session?disableCookieCache=true', origin),
		{ credentials: 'include', redirect: 'error' },
	);
	if (!response.ok)
		throw new Error(`/auth/get-session failed with ${response.status}.`);
	const body = (await response.json()) as {
		user?: { id?: unknown; email?: unknown };
	} | null;
	if (!body?.user) return null;
	const principal = { id: body.user.id, email: body.user.email };
	if (!Principal.allows(principal))
		throw new Error('/auth/get-session returned an unreadable user.');
	return principal as Principal;
}

export type CreateCookieSessionAuthOptions = {
	/** This page's origin: the authorization server's. */
	origin: string;
	/** Leave for the sign-in page. Tests replace it. */
	navigate: (url: string) => void;
	/** The same-origin path sign-in returns to. Read when sign-in starts. */
	returnPath: () => string;
	fetch?: AuthFetch;
};

/**
 * Hold the cookie session as an `AuthClient`.
 *
 * State starts signed out; `refresh()` reads the cookie session and is the only
 * way an Account appears. A different person, or no person, retires the
 * current Account: its `fetch` and in-flight requests abort, so a dashboard
 * mounted for Alice cannot read or change anything once the cookie names Bob.
 */
export function createCookieSessionAuth({
	origin,
	navigate,
	returnPath,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
}: CreateCookieSessionAuthOptions) {
	let attachment: { account: Account; lifetime: AbortController } | null = null;
	let state: AuthState = { status: 'signed-out' };
	let disposed = false;
	const listeners = new Set<(state: AuthState) => void>();

	function publish(next: AuthState) {
		if (next.status === state.status && next.account === state.account) return;
		state = next;
		for (const listener of listeners) listener(state);
	}

	/** Retire the current Account, then publish the next one or none. */
	function replace(principal: Principal | null) {
		const previous = attachment;
		attachment = null;
		previous?.lifetime.abort();
		if (principal) attach(principal);
		else publish({ status: 'signed-out' });
	}

	function attach(principal: Principal) {
		const lifetime = new AbortController();
		const accountFetch: AuthFetch = async (input, init) => {
			const target =
				input instanceof Request ? new URL(input.url) : new URL(input, origin);
			if (target.origin !== origin || target.username || target.password)
				throw new TypeError('Account requests must target their own server.');
			const caller =
				init?.signal ?? (input instanceof Request ? input.signal : null);
			const signal = caller
				? AbortSignal.any([lifetime.signal, caller])
				: lifetime.signal;
			signal.throwIfAborted();
			const headers = new Headers(
				input instanceof Request ? input.headers : undefined,
			);
			new Headers(init?.headers).forEach((value, key) => {
				headers.set(key, value);
			});
			// The cookie is the only credential this page holds.
			headers.delete('authorization');
			headers.delete('cookie');
			const response = await fetchImpl(
				input instanceof Request ? input.clone() : target.href,
				{
					...init,
					headers,
					signal,
					credentials: 'include',
					redirect: 'manual',
				},
			);
			signal.throwIfAborted();
			// The cookie session ended or changed hands: read it again so the
			// Account this request belonged to retires.
			if (response.status === 401) void refresh();
			return response;
		};
		const account: Account = Object.freeze({
			authorityId: 'epicenter-api',
			principalId: principal.id,
			baseURL: origin,
			signal: lifetime.signal,
			fetch: accountFetch,
			getProfile: () => getProfileVia(accountFetch),
		});
		attachment = { account, lifetime };
		publish({ status: 'signed-in', account });
	}

	async function getProfileVia(
		fetchVia: AuthFetch,
	): Promise<Result<Principal, AuthError>> {
		const { data: principal, error } = await tryAsync({
			try: () => readSessionPrincipal(fetchVia, origin),
			catch: (cause) => AuthError.ProfileUnavailable({ cause }),
		});
		if (error) return Err(error);
		if (!principal)
			return AuthError.ProfileUnavailable({ cause: 'No session.' });
		return Ok(principal);
	}

	let reading: Promise<void> | undefined;
	/** Read the cookie session and attach, keep, or retire the Account. */
	function refresh(): Promise<void> {
		reading ??= (async () => {
			try {
				const principal = await readSessionPrincipal(fetchImpl, origin);
				if (disposed) return;
				if (attachment?.account.principalId === principal?.id) return;
				replace(principal);
			} catch {
				// An unreadable session leaves the current state; a later read decides.
			} finally {
				reading = undefined;
			}
		})();
		return reading;
	}

	const auth = {
		baseURL: origin,
		getState: () => state,
		onStateChange(fn: (state: AuthState) => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		/** Leave for this server's sign-in page, which returns to `returnPath`. */
		async startSignIn({
			reauthenticate = false,
		} = {}): Promise<Result<undefined, AuthError>> {
			const params = new URLSearchParams({ return: returnPath() });
			if (reauthenticate) params.set('reauth', '1');
			navigate(`/sign-in?${params}`);
			return Ok(undefined);
		},
		async signOut() {
			const { data: response, error } = await tryAsync({
				try: () =>
					fetchImpl(new URL('/auth/sign-out', origin), {
						method: 'POST',
						credentials: 'include',
						redirect: 'error',
						headers: { 'content-type': 'application/json' },
						body: '{}',
					}),
				catch: (cause) => AuthError.SignOutFailed({ cause }),
			});
			if (error) return Err(error);
			if (!response.ok)
				return AuthError.SignOutFailed({
					cause: `/auth/sign-out failed with ${response.status}.`,
				});
			replace(null);
			return Ok(undefined);
		},
		getProfile: () => getProfileVia(fetchImpl),
		refresh,
		[Symbol.dispose]() {
			disposed = true;
			listeners.clear();
			replace(null);
		},
	} satisfies AuthClient & { refresh(): Promise<void> };
	return auth;
}
