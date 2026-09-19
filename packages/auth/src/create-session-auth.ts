import { bearerSubprotocol } from '@epicenter/sync/auth-subprotocol';
import { defineErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { type Result, tryAsync } from 'wellcrafted/result';
import type {
	Account,
	AuthFetch,
	AuthState,
	CallbackAuthClient,
	SessionAuthClient,
} from './auth-contract.js';
import {
	AccountUnavailable,
	AuthError,
	OpenWebSocketDenied,
} from './auth-errors.js';
import type { PersistedAuth } from './auth-types.js';
import type { PersistedAuthStorage } from './persisted-auth-storage.js';
import { getProfileVia, readApiSession } from './read-api-session.js';
import { resolveTargetUrl } from './resolve-target-url.js';

export type SessionLauncher = {
	startSignIn(options: {
		signal: AbortSignal;
		reauthenticate: boolean;
	}): Promise<{ status: 'launched' } | { status: 'completed'; token: string }>;
	completeSignIn?(options: { signal: AbortSignal }): Promise<string>;
	cancel?(): void;
};

type AccountAuthOptions = {
	baseURL: string;
	supportsShared?: boolean;
	persistedAuthStorage: PersistedAuthStorage;
	fetch?: AuthFetch;
	WebSocket?: typeof WebSocket;
	log?: Logger;
};

export type CreateSessionAuthOptions = AccountAuthOptions & {
	/** Trusted installation identity; preserve existing authority bytes. */
	authorityId: string;
	launcher: SessionLauncher;
};

type Attachment = {
	account: Account;
	lifetime: AbortController;
	credential: {
		value: PersistedAuth;
		verified: boolean;
		flight?: Promise<void>;
	};
	paused: boolean;
};

const SessionDiagnostic = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: 'Auth background operation failed.',
		cause,
	}),
});

export function createSessionAuth(
	options: CreateSessionAuthOptions & {
		launcher: SessionLauncher & {
			completeSignIn(options: { signal: AbortSignal }): Promise<string>;
		};
	},
): CallbackAuthClient;
export function createSessionAuth(
	options: CreateSessionAuthOptions,
): SessionAuthClient;
/** Own one session credential and uninterrupted Account attachment.
 * Restored identity is available offline; transport verifies it before first use.
 * Storage writes, including rollback of cancelled installation, are serialized.
 */
export function createSessionAuth(
	options: CreateSessionAuthOptions,
): SessionAuthClient {
	const {
		baseURL,
		fetch: fetchImpl = globalThis.fetch.bind(globalThis),
		log = createLogger('auth/session'),
	} = options;
	function revoke(token: string): Promise<void> {
		return Promise.resolve()
			.then(async () => {
				const signal = AbortSignal.timeout(5_000);
				const response = await whileActive(
					fetchImpl(new URL('/auth/sign-out', baseURL), {
						signal,
						method: 'POST',
						credentials: 'omit',
						redirect: 'error',
						headers: {
							authorization: `Bearer ${token}`,
							'content-type': 'application/json',
						},
						body: '{}',
					}),
					signal,
				);
				if (response.body) await whileActive(response.body.cancel(), signal);
				if (!response.ok)
					throw new Error(`Session revocation failed (${response.status}).`);
			})
			.catch((cause: unknown) =>
				log.error(SessionDiagnostic.Failed({ cause })),
			);
	}

	const { auth, run, install, cancelSignIn } = createBearerAuth(
		{
			...options,
			cancel: () => options.launcher.cancel?.(),
		},
		revoke,
	);
	const { launcher } = options;
	return Object.assign(auth, {
		cancelSignIn,
		startSignIn({
			reauthenticate = auth.getState().status === 'reauth-required',
		} = {}) {
			return run('start', async (signal) => {
				const result = await launcher.startSignIn({ signal, reauthenticate });
				if (result.status === 'completed') await install(result.token, signal);
				else signal.throwIfAborted();
			});
		},
		...(launcher.completeSignIn
			? {
					completeSignIn() {
						return run('complete', async (signal) => {
							await install(await launcher.completeSignIn!({ signal }), signal);
						});
					},
				}
			: {}),
	});
}

function createBearerAuth(
	{
		authorityId,
		baseURL,
		persistedAuthStorage,
		cancel,
		supportsShared = false,
		fetch: fetchImpl = globalThis.fetch.bind(globalThis),
		WebSocket: WebSocketImpl = globalThis.WebSocket,
		log = createLogger('auth/session'),
	}: AccountAuthOptions & {
		authorityId: string;
		cancel?: () => void;
	},
	revoke: (token: string) => Promise<void>,
) {
	const origin = new URL(baseURL).origin;
	let persisted = persistedAuthStorage.initial;
	let attachment: Attachment | null = null;
	let state: AuthState = { status: 'signed-out' };
	let disposed = false;
	let writes: Promise<void> = Promise.resolve();
	let attempt: AbortController | undefined;
	let cancellation: Promise<void> | undefined;
	let flight:
		| {
				kind: 'start' | 'complete';
				promise: Promise<Result<undefined, AuthError>>;
		  }
		| undefined;
	const listeners = new Set<(state: AuthState) => void>();

	function publish() {
		const next: AuthState = attachment
			? {
					status: attachment.paused ? 'reauth-required' : 'signed-in',
					account: attachment.account,
				}
			: { status: 'signed-out' };
		if (next.status === state.status && next.account === state.account) return;
		state = next;
		for (const listener of listeners) {
			try {
				listener(state);
			} catch (cause) {
				log.error(SessionDiagnostic.Failed({ cause }));
			}
		}
	}

	function enqueue(operation: () => Promise<void>) {
		const pending = writes.catch(() => undefined).then(operation);
		writes = pending;
		void pending.catch(() => undefined);
		return pending;
	}

	function retire() {
		const previous = attachment;
		attachment = null;
		previous?.lifetime.abort();
		publish();
	}

	function pause(owner: Attachment, credential: Attachment['credential']) {
		if (attachment !== owner || owner.credential !== credential) return;
		owner.paused = true;
		publish();
	}

	async function verify(
		owner: Attachment,
		credential: Attachment['credential'],
	) {
		const result = await readApiSession({
			baseURL,
			token: credential.value.token,
			fetch: fetchImpl,
		});
		if (attachment !== owner || owner.credential !== credential) return;
		if (result.error) {
			if (result.error.name === 'Rejected') pause(owner, credential);
			return;
		}
		if (result.data.principalId !== owner.account.principalId) {
			await enqueue(async () => {
				if (attachment !== owner || owner.credential !== credential) return;
				persisted = null;
				retire();
				await persistedAuthStorage.set(null);
			});
			return;
		}
		credential.verified = true;
	}

	async function authorize(owner: Attachment, signal: AbortSignal) {
		for (;;) {
			signal.throwIfAborted();
			if (owner.paused)
				throw AccountUnavailable({ code: 'reauth-required' }).error;
			const credential = owner.credential;
			if (!credential.verified) {
				credential.flight ??= verify(owner, credential).finally(() => {
					credential.flight = undefined;
				});
				await whileActive(credential.flight, signal);
				signal.throwIfAborted();
				if (credential !== owner.credential) continue;
				if (!credential.verified)
					throw AccountUnavailable({
						code: owner.paused ? 'reauth-required' : 'auth-unavailable',
					}).error;
			}
			return credential;
		}
	}

	function createAttachment(
		value: PersistedAuth,
		verified: boolean,
	): Attachment {
		const lifetime = new AbortController();
		function requireServer(input: Request | string | URL) {
			const target = resolveTargetUrl(input, baseURL);
			if (target?.origin !== origin || target.username || target.password)
				throw new TypeError('Account requests must target their own server.');
			return target;
		}
		const accountFetch: AuthFetch = async (input, init) => {
			const target = requireServer(input);
			if (init?.body instanceof ReadableStream) {
				input = new Request(input instanceof Request ? input : target, init);
				init = undefined;
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
			async function send() {
				const credential = await authorize(owner, signal);
				signal.throwIfAborted();
				const headers = new Headers(
					input instanceof Request ? input.headers : undefined,
				);
				new Headers(init?.headers).forEach((value, key) =>
					headers.set(key, value),
				);
				headers.set('authorization', `Bearer ${credential.value.token}`);
				headers.delete('cookie');
				const response = await whileActive(
					fetchImpl(
						input instanceof Request ? (input.clone() as Request) : target.href,
						{
							...init,
							headers,
							signal,
							credentials: 'omit',
							redirect: 'manual',
						},
					),
					signal,
				);
				signal.throwIfAborted();
				return { response, credential };
			}
			const first = await send();
			if (first.response.status !== 401) return first.response;
			if (first.credential === owner.credential) {
				pause(owner, first.credential);
				return first.response;
			}
			await first.response.body?.cancel();
			const retry = await send();
			if (retry.response.status === 401) pause(owner, retry.credential);
			return retry.response;
		};
		const account: Account = Object.freeze({
			supportsShared,
			authorityId,
			principalId: value.principalId,
			baseURL,
			fetch: accountFetch,
			getProfile: () => getProfileVia(accountFetch, baseURL),
			async openWebSocket(address: Parameters<Account['openWebSocket']>[0]) {
				const url = new URL(address.url);
				if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
					throw new TypeError('Account sockets must use ws or wss.');
				url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
				requireServer(url);
				let credential: Attachment['credential'];
				try {
					credential = await authorize(owner, lifetime.signal);
					lifetime.signal.throwIfAborted();
				} catch (error) {
					if (lifetime.signal.aborted)
						throw OpenWebSocketDenied({ code: 'signed-out' }).error;
					if (owner.paused)
						throw OpenWebSocketDenied({ code: 'reauth-required' }).error;
					throw OpenWebSocketDenied({ code: 'auth-unavailable' }).error;
				}
				const socket = new WebSocketImpl(address.url, [
					...address.protocols,
					bearerSubprotocol(credential.value.token),
				]);
				const close = () => socket.close();
				lifetime.signal.addEventListener('abort', close, { once: true });
				socket.addEventListener(
					'close',
					() => lifetime.signal.removeEventListener('abort', close),
					{ once: true },
				);
				if (lifetime.signal.aborted) close();
				return socket;
			},
		});
		const owner: Attachment = {
			account,
			lifetime,
			credential: { value, verified },
			paused: false,
		};
		return owner;
	}

	async function install(token: string, signal: AbortSignal) {
		let revocation: Promise<void> | undefined;
		try {
			signal.throwIfAborted();
			const result = await whileActive(
				readApiSession({ baseURL, token, fetch: fetchImpl }),
				signal,
			);
			signal.throwIfAborted();
			if (result.error) throw result.error;
			const next: PersistedAuth = {
				token,
				principalId: result.data.principalId,
			};
			await enqueue(async () => {
				signal.throwIfAborted();
				if (attachment && attachment.account.principalId !== next.principalId) {
					const previous = persisted;
					persisted = null;
					retire();
					await persistedAuthStorage.set(null);
					if (previous && previous.token !== token)
						revocation = revoke(previous.token);
				}
				signal.throwIfAborted();
				await persistedAuthStorage.set(next);
				if (signal.aborted) {
					await persistedAuthStorage.set(persisted);
					signal.throwIfAborted();
				}
				const previous = persisted;
				persisted = next;
				if (attachment) {
					attachment.credential = { value: next, verified: true };
					attachment.paused = false;
				} else attachment = createAttachment(next, true);
				publish();
				if (previous && previous.token !== token)
					revocation = revoke(previous.token);
				signal.throwIfAborted();
			});
			await revocation;
			signal.throwIfAborted();
		} catch (cause) {
			if (persisted?.token !== token) void revoke(token);
			throw cause;
		}
	}

	function run(
		kind: 'start' | 'complete',
		operation: (signal: AbortSignal) => Promise<void>,
	) {
		const fail =
			kind === 'start'
				? AuthError.StartSignInFailed
				: AuthError.CompleteSignInFailed;
		if (disposed)
			return Promise.resolve(fail({ cause: 'Auth client disposed.' }));
		if (cancellation)
			return Promise.resolve(
				fail({ cause: 'Sign-in cancellation is pending.' }),
			);
		if (flight?.kind === kind) return flight.promise;
		attempt?.abort();
		attempt = new AbortController();
		const signal = attempt.signal;
		const promise = tryAsync({
			try: async () => {
				await whileActive(
					Promise.resolve().then(() => {
						signal.throwIfAborted();
						return operation(signal);
					}),
					signal,
				);
				signal.throwIfAborted();
				return undefined;
			},
			catch: (cause) => fail({ cause }),
		}).finally(() => {
			if (flight?.promise === promise) flight = undefined;
		});
		flight = { kind, promise };
		return promise;
	}

	if (persisted) {
		attachment = createAttachment(persisted, false);
		publish();
	}
	const auth = {
		getState() {
			return state;
		},
		baseURL,
		onStateChange(fn: (state: AuthState) => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		signOut() {
			const previous = persisted;
			attempt?.abort();
			flight = undefined;
			persisted = null;
			retire();
			const clearing = enqueue(async () => {
				await persistedAuthStorage.set(null);
			});
			const revocation = previous ? revoke(previous.token) : Promise.resolve();
			return tryAsync({
				try: async () => {
					try {
						cancel?.();
					} finally {
						await clearing.finally(() => revocation);
					}
					return undefined;
				},
				catch: (cause) => AuthError.SignOutFailed({ cause }),
			});
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
			attempt?.abort();
			flight = undefined;
			retire();
			listeners.clear();
			try {
				cancel?.();
			} catch (cause) {
				log.error(SessionDiagnostic.Failed({ cause }));
			}
		},
	};
	return {
		auth,
		run,
		install,
		cancelSignIn() {
			if (cancellation) return cancellation;
			const pending = flight?.promise;
			const signal = attempt?.signal;
			attempt?.abort();
			const settling = Promise.resolve()
				.then(async () => {
					try {
						cancel?.();
					} finally {
						await pending;
						// A native credential write cannot be interrupted. Its rollback
						// must finish before the caller can reopen applications.
						await writes.catch(async (cause) => {
							if (cause === signal?.reason) return;
							// Retry a failed rollback even after the original flight ended.
							await enqueue(async () => persistedAuthStorage.set(persisted));
						});
					}
				})
				.finally(() => {
					if (cancellation === settling) cancellation = undefined;
				});
			cancellation = settling;
			return settling;
		},
	};
}

/** A caller can stop waiting without aborting another caller's verification. */
function whileActive<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void promise.catch(() => undefined);
		return Promise.reject(signal.reason);
	}
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		void promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener('abort', abort));
	});
}
