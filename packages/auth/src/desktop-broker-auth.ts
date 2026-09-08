import { STORE_SYNC_ROUTE } from '@epicenter/sync';
import { isOpenWebSocketDenial } from '@epicenter/sync/transport';
import { Ok } from 'wellcrafted/result';
import type {
	Account,
	AuthClient,
	AuthFetch,
	AuthState,
	ConnectionStatus,
} from './auth-contract.js';
import { AuthError, OpenWebSocketDenied } from './auth-errors.js';
import type { AuthIdentityState } from './auth-identity-state.js';
import { getProfileVia } from './read-api-session.js';
import { resolveTargetUrl } from './resolve-target-url.js';

/**
 * Non-secret identity projection a desktop window boots with. The Bun
 * authority serializes this into each trusted SPA document at serve time; it
 * never contains a bearer, refresh grant, or instance token.
 */
export type DesktopAuthBootstrap = {
	state: AuthIdentityState;
	connection: {
		authorityId: string;
		baseURL: string;
		status: ConnectionStatus;
	};
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
	WebSocket: WebSocketImpl = globalThis.WebSocket,
}: {
	bootstrap?: DesktopAuthBootstrap;
	brokerBaseURL: string;
	fetch?: AuthFetch;
	WebSocket?: typeof WebSocket;
}): AuthClient {
	const baseURL = bootstrap.connection.baseURL;
	const origin = new URL(baseURL).origin;
	const broker = createDesktopBroker({ brokerBaseURL, fetch: fetchImpl });
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
		const headers = remote.headers;
		headers.delete('authorization');
		headers.delete('cookie');
		const signal = AbortSignal.any([lifetime.signal, remote.signal]);
		const response = await fetchImpl(new Request(local, remote), {
			headers,
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
					authorityId: bootstrap.connection.authorityId,
					principalId: bootstrap.state.principalId,
					baseURL,
					fetch: accountFetch,
					getProfile: () => getProfileVia(accountFetch, baseURL),
					async openWebSocket(address) {
						if (lifetime.signal.aborted)
							throw OpenWebSocketDenied({ code: 'signed-out' }).error;
						const target = new URL(address.url);
						target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
						if (
							target.origin !== origin ||
							target.pathname !== STORE_SYNC_ROUTE.pattern
						)
							throw new TypeError('Account sync must target its own server.');
						const local = new URL('/_epicenter/account/sync', brokerBaseURL);
						local.protocol = local.protocol === 'https:' ? 'wss:' : 'ws:';
						local.search = target.search;
						const socket = new WebSocketImpl(local);
						socket.binaryType = 'arraybuffer';
						return new Promise<WebSocket>((resolve, reject) => {
							let ready = false;
							const timeout = setTimeout(
								() => fail(new Error('Desktop sync handshake timed out.')),
								30_000,
							);
							const abort = () =>
								fail(OpenWebSocketDenied({ code: 'signed-out' }).error);
							function fail(error: unknown) {
								clearTimeout(timeout);
								if (!ready) reject(error);
								socket.close();
							}
							lifetime.signal.addEventListener('abort', abort, { once: true });
							socket.addEventListener(
								'close',
								() => {
									lifetime.signal.removeEventListener('abort', abort);
									clearTimeout(timeout);
									if (!ready)
										reject(
											new Error('Desktop sync closed before it was ready.'),
										);
								},
								{ once: true },
							);
							socket.addEventListener(
								'error',
								() => fail(new Error('Desktop sync connection failed.')),
								{ once: true },
							);
							socket.addEventListener(
								'message',
								(event) => {
									try {
										const message = JSON.parse(String(event.data));
										if (message.type === 'refused') {
											const denial = OpenWebSocketDenied({
												code: message.code,
											}).error;
											if (!isOpenWebSocketDenial(denial))
												throw new Error('Invalid desktop sync refusal.');
											if (
												denial.code === 'signed-out' ||
												denial.code === 'reauth-required'
											)
												publish(denial.code);
											fail(denial);
											return;
										}
										if (message.type !== 'ready')
											throw new Error('Invalid desktop sync handshake.');
										clearTimeout(timeout);
										ready = true;
										resolve(socket);
									} catch (error) {
										fail(error);
									}
								},
								{ once: true },
							);
							if (lifetime.signal.aborted) abort();
						});
					},
				});
	if (bootstrap.state.status !== 'signed-out' && account)
		state = { status: bootstrap.state.status, account };
	return {
		get state() {
			return state;
		},
		connection: {
			baseURL,
			get status() {
				return bootstrap.connection.status;
			},
			onChange() {
				return () => undefined;
			},
		},
		onStateChange(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		async startSignIn() {
			try {
				await broker('/_epicenter/account/sign-in', {});
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			publish('signed-out');
			try {
				await broker('/_epicenter/account/sign-out', {});
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
		[Symbol.dispose]() {
			lifetime.abort();
			listeners.clear();
		},
	};
}
