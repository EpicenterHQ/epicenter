import { bearerSubprotocol } from '@epicenter/sync/auth-subprotocol';
import type { Account, AuthFetch } from './auth-contract.js';
import { AccountUnavailable, OpenWebSocketDenied } from './auth-errors.js';
import { fetchWithBearer, resolveTargetUrl } from './bearer-fetch.js';
import type { OAuthCredentialAuthority } from './oauth-credential-authority.js';
import { getProfileVia } from './read-api-session.js';

/** Construct transports for the authority's current attachment, never its next. */
export function createOAuthAccount(
	authority: OAuthCredentialAuthority,
	{
		fetch: fetchImpl = globalThis.fetch.bind(globalThis),
		WebSocket: WebSocketImpl = globalThis.WebSocket,
	}: {
		fetch?: AuthFetch;
		WebSocket?: typeof WebSocket;
	} = {},
): Account | null {
	const { state, accountSignal } = authority.snapshot;
	if (state.status === 'signed-out' || accountSignal === null) return null;
	const { principalId } = state;
	const { baseURL } = authority;
	const origin = new URL(baseURL).origin;

	function requireServer(input: Request | string | URL) {
		const target = resolveTargetUrl(input, baseURL);
		if (target?.origin !== origin)
			throw new TypeError('Account requests must target their own server.');
		return target;
	}

	const accountFetch: AuthFetch = async (input, init) => {
		const target = requireServer(input);
		// A stream in RequestInit is single-use. Retain one Request as the replay
		// source, just as for a caller-supplied Request. Each attempt consumes a clone.
		if (init?.body instanceof ReadableStream) {
			input = new Request(input instanceof Request ? input : target, init);
			init = undefined;
		}
		const callerSignal =
			init?.signal !== undefined
				? init.signal
				: input instanceof Request
					? input.signal
					: null;
		const signal = callerSignal
			? AbortSignal.any([accountSignal, callerSignal])
			: accountSignal;
		signal.throwIfAborted();
		const dispatch: AuthFetch = (request, options) => {
			signal.throwIfAborted();
			return fetchImpl(request, { ...options, signal });
		};
		async function send(forceRefresh: boolean) {
			const authorization = await whileActive(
				authority.authorize({ accountSignal, forceRefresh }),
				signal,
			);
			signal.throwIfAborted();
			if (authorization.status === 'denied')
				throw AccountUnavailable({ code: authorization.code }).error;
			const response = await fetchWithBearer({
				input,
				init,
				fetch: dispatch,
				baseURL,
				epicenterOrigin: origin,
				resolveToken: async () => authorization.accessToken,
			});
			signal.throwIfAborted();
			return { response, authorization };
		}
		const first = await send(false);
		if (first.response.status !== 401) return first.response;
		await first.response.body?.cancel();
		const retry = await send(true);
		if (retry.response.status === 401)
			authority.reportRejected(retry.authorization.tokenGeneration);
		return retry.response;
	};

	return Object.freeze({
		principalId,
		baseURL,
		fetch: accountFetch,
		getProfile: () => getProfileVia(accountFetch, baseURL),
		async openWebSocket(address) {
			const url = new URL(address.url);
			url.protocol =
				url.protocol === 'wss:'
					? 'https:'
					: url.protocol === 'ws:'
						? 'http:'
						: url.protocol;
			requireServer(url);
			if (accountSignal.aborted)
				throw OpenWebSocketDenied({ code: 'signed-out' }).error;
			const authorization = await whileActive(
				authority.authorize({ accountSignal }),
				accountSignal,
			).catch((error: unknown) => {
				if (accountSignal.aborted)
					throw OpenWebSocketDenied({ code: 'signed-out' }).error;
				throw error;
			});
			if (accountSignal.aborted)
				throw OpenWebSocketDenied({ code: 'signed-out' }).error;
			if (authorization.status === 'denied')
				throw OpenWebSocketDenied({ code: authorization.code }).error;
			const socket = new WebSocketImpl(address.url, [
				...address.protocols,
				bearerSubprotocol(authorization.accessToken),
			]);
			const close = () => socket.close();
			accountSignal.addEventListener('abort', close, { once: true });
			socket.addEventListener(
				'close',
				() => accountSignal.removeEventListener('abort', close),
				{ once: true },
			);
			if (accountSignal.aborted) close();
			return socket;
		},
	});
}

/** Cancelling one operation must not cancel another operation's shared refresh. */
function whileActive<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener('abort', abort));
	});
}
