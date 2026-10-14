import { Ok } from 'wellcrafted/result';
import { createAccountManagementUrl } from './account-management.js';
import type {
	Account,
	AuthClient,
	AuthFetch,
	AuthState,
} from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import type { AuthIdentityState } from './auth-identity-state.js';
import type { AuthServer } from './auth-server.js';
import { getProfileVia } from './read-api-session.js';
import { resolveTargetUrl } from './resolve-target-url.js';

/**
 * Non-secret identity projection a desktop window boots with. The Bun
 * authority serializes this into each trusted SPA document at serve time; it
 * never contains a bearer, refresh grant, or instance token.
 */
export type DesktopAuthBootstrap = {
	state: AuthIdentityState;
	server: AuthServer;
	accountManagement: boolean;
	credentialUnreadable: boolean;
};

/** Where the Bun authority stamps the boot snapshot into a served document. */
const BOOTSTRAP_ELEMENT_ID = 'epicenter-auth-bootstrap';

/**
 * Read this window's boot snapshot out of the document the host served, and
 * take it out of the DOM.
 *
 * Every compiled application parses the same element, so the parse lives with
 * the client that consumes it rather than being copied per application. The
 * removal is the point of doing it once and eagerly: an identity snapshot has
 * no business sitting in the DOM after boot, and nothing may read it a second
 * time, because which replica a build opens is decided by which build the host
 * served and never by what survives in its `<head>`.
 *
 * A missing or unparseable element throws. A build that calls this is one the
 * desktop host serves, so the snapshot's absence is a broken host contract, not
 * a state to degrade into.
 */
export function readDesktopAuthBootstrap(): DesktopAuthBootstrap {
	const element = document.querySelector<HTMLScriptElement>(
		`#${BOOTSTRAP_ELEMENT_ID}`,
	);
	if (!element) {
		throw new Error('Epicenter did not provide the desktop auth bootstrap.');
	}
	try {
		return JSON.parse(element.textContent ?? '') as DesktopAuthBootstrap;
	} catch (cause) {
		throw new Error('Epicenter provided an invalid desktop auth bootstrap.', {
			cause,
		});
	} finally {
		element.remove();
	}
}

function createDesktopBroker({
	brokerBaseURL,
	fetch,
}: {
	brokerBaseURL: string;
	fetch: AuthFetch;
}) {
	return async function broker<T>(path: string, body?: unknown): Promise<T> {
		const response = await fetch(new URL(path, brokerBaseURL), {
			method: body === undefined ? 'GET' : 'POST',
			credentials: 'include',
			headers:
				body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) {
			throw new Error(`Desktop auth broker failed (${response.status}).`);
		}
		if (!response.headers.get('content-type')?.includes('application/json')) {
			return undefined as T;
		}
		return (await response.json()) as T;
	};
}

/** The window holds account identity; Bun carries its authenticated traffic. */
export function createDesktopBrokerAuth({
	bootstrap = readDesktopAuthBootstrap(),
	brokerBaseURL,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
}: {
	bootstrap?: DesktopAuthBootstrap;
	brokerBaseURL: string;
	fetch?: AuthFetch;
}): AuthClient {
	const baseURL = bootstrap.server.baseURL;
	const origin = new URL(baseURL).origin;
	const broker = createDesktopBroker({
		brokerBaseURL,
		fetch: async (input, init) => {
			const response = await fetchImpl(input, init);
			observe(response.headers.get('x-epicenter-auth-state'));
			return response;
		},
	});
	const lifetime = new AbortController();
	const listeners = new Set<(state: AuthState) => void>();
	let state: AuthState = { status: 'signed-out' };
	function publish(status: AuthState['status']) {
		if (lifetime.signal.aborted && status !== 'signed-out') return;
		if (status === 'signed-out') lifetime.abort();
		if (state.status === status) return;
		state =
			status === 'signed-out' || !account
				? { status: 'signed-out' }
				: { status, account };
		for (const listener of listeners) listener(state);
	}
	function observe(status: string | null) {
		// Successful desktop reauthentication relaunches into a fresh bootstrap.
		// A delayed success header must not erase a newer credential refusal.
		if (status === 'signed-out' || status === 'reauth-required')
			publish(status);
	}
	const accountFetch: AuthFetch = async (input, init) => {
		lifetime.signal.throwIfAborted();
		const target = resolveTargetUrl(input, baseURL);
		if (target?.origin !== origin)
			throw new TypeError('Account requests must target their own server.');
		const remote =
			input instanceof Request
				? new Request(input, init)
				: new Request(target, init);
		const local = new URL('/_epicenter/account/http', brokerBaseURL);
		local.searchParams.set('path', target.pathname + target.search);
		remote.headers.delete('authorization');
		remote.headers.delete('cookie');
		const signal = AbortSignal.any([lifetime.signal, remote.signal]);
		// Reconstructing a Request turns even binary and FormData bodies into
		// streaming uploads, which WebKit rejects. Preserve the encoded bytes
		// and cancel their preparation with the captured request lifetime.
		const body = remote.body
			? await new Response(
					remote.body.pipeThrough(new TransformStream(), { signal }),
				).blob()
			: undefined;
		signal.throwIfAborted();
		const response = await fetchImpl(local, {
			method: remote.method,
			headers: remote.headers,
			body,
			cache: remote.cache,
			integrity: remote.integrity,
			keepalive: remote.keepalive,
			mode: remote.mode,
			referrer: remote.referrer,
			referrerPolicy: remote.referrerPolicy,
			credentials: 'include',
			redirect: 'manual',
			signal,
		});
		lifetime.signal.throwIfAborted();
		observe(response.headers.get('x-epicenter-auth-state'));
		return response;
	};
	const account: Account | null =
		bootstrap.state.status === 'signed-out'
			? null
			: Object.freeze({
					authorityId: bootstrap.server.authorityId,
					principalId: bootstrap.state.principalId,
					baseURL,
					fetch: accountFetch,
					getProfile: () => getProfileVia(accountFetch, baseURL),
				});
	if (bootstrap.state.status !== 'signed-out' && account)
		state = { status: bootstrap.state.status, account };
	const auth: AuthClient = {
		getState() {
			return state;
		},
		baseURL,
		onStateChange(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		async startSignIn(options) {
			try {
				await broker('/_epicenter/account/sign-in', options ?? {});
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				await broker('/_epicenter/account/sign-out', {});
				publish('signed-out');
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
		},
		getProfile() {
			return (
				account?.getProfile() ??
				Promise.resolve(AuthError.ProfileUnavailable({ cause: 'Signed out.' }))
			);
		},
		...(bootstrap.accountManagement
			? { accountManagementUrl: createAccountManagementUrl }
			: {}),
		[Symbol.dispose]() {
			lifetime.abort();
			listeners.clear();
		},
	};
	return auth;
}
