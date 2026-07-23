import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/sync/auth-subprotocol';
import type { Logger } from 'wellcrafted/logger';
import type { AuthFetch, SyncAuthClient } from './auth-contract.js';
import { OpenWebSocketDenied } from './auth-errors.js';
import {
	type AuthFetchInput,
	fetchWithBearer,
	resolveTargetUrl,
} from './bearer-fetch.js';
import type { BearerAuthorization } from './credential-authority.js';
import { createInstanceCredentialAuthority } from './instance-credential-authority.js';
import { getProfileVia } from './read-api-session.js';

/** Construction inputs for a self-hosted static-token client. */
export type CreateInstanceTokenAuthConfig = {
	/**
	 * Base URL of the self-hosted Epicenter server. The bearer is attached only
	 * to this origin (ADR-0053).
	 */
	baseURL: string;
	/**
	 * Operator-supplied instance bearer. The authority verifies but never
	 * refreshes, revokes, or persists it.
	 */
	token: string;
	/** Fetch used for verification and local authenticated resource calls. */
	fetch?: AuthFetch;
	/** WebSocket constructor for browser transport or injected tests. */
	WebSocket?: typeof WebSocket;
	/** Library logger for subscriber failures. */
	log?: Logger;
};

/**
 * Compose one static instance credential authority with local HTTP and
 * WebSocket transports. The instance token remains audience-scoped to its own
 * origin and is never exposed on the returned client. Identity boots
 * optimistically as the instance principal for replica attachment, but
 * resource transports wait for `/api/session` verification.
 */
export function createInstanceTokenAuth({
	baseURL,
	token,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	WebSocket: WebSocketImpl = globalThis.WebSocket,
	log,
}: CreateInstanceTokenAuthConfig): SyncAuthClient {
	const epicenterOrigin = new URL(baseURL).origin;
	const authority = createInstanceCredentialAuthority(
		{ fetch: fetchImpl, log },
		{ baseURL, token },
	);

	async function fetchWithAuth(
		input: AuthFetchInput,
		init: RequestInit | undefined,
		providedAuthorization?: BearerAuthorization,
	) {
		let authorization = providedAuthorization;
		const response = await fetchWithBearer({
			input,
			init,
			fetch: fetchImpl,
			baseURL,
			epicenterOrigin,
			resolveToken: async () => {
				authorization ??= await authority.authorize();
				return authorization.status === 'authorized'
					? authorization.accessToken
					: null;
			},
		});
		return { response, authorization };
	}

	async function authedFetch(input: AuthFetchInput, init?: RequestInit) {
		const result = await fetchWithAuth(input, init);
		if (
			result.response.status === 401 &&
			resolveTargetUrl(input, baseURL)?.origin === epicenterOrigin &&
			result.authorization?.status === 'authorized'
		) {
			authority.reportRejected(result.authorization.tokenGeneration);
		}
		return result.response;
	}

	return {
		get state() {
			return authority.snapshot.state;
		},
		deployment: {
			kind: 'self-hosted',
			baseURL,
			connection: {
				get status() {
					return authority.snapshot.connectionStatus;
				},
				onChange(fn) {
					return authority.onConnectionChange(fn);
				},
			},
		},
		onStateChange(fn) {
			return authority.onStateChange(fn);
		},
		startSignIn() {
			return authority.startSignIn();
		},
		signOut() {
			return authority.signOut();
		},
		fetch: authedFetch,
		getProfile: () => getProfileVia(authedFetch, baseURL),
		async openWebSocket(url, protocols = []) {
			const authorization = await authority.authorize();
			if (authorization.status === 'denied') {
				throw OpenWebSocketDenied({
					permanence: authorization.permanence,
					code: authorization.code,
				}).error;
			}
			return new WebSocketImpl(String(url), [
				...protocols,
				`${BEARER_SUBPROTOCOL_PREFIX}${authorization.accessToken}`,
			]);
		},
		[Symbol.dispose]() {
			authority[Symbol.dispose]();
		},
	};
}
