import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import type { Logger } from 'wellcrafted/logger';
import type {
	AuthClient,
	AuthFetch,
	AuthState,
	CallbackAuthClient,
} from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import { createOAuthAccount } from './oauth-account.js';
import { createOAuthCredentialAuthority } from './oauth-credential-authority.js';
import type {
	CallbackOAuthLauncher,
	OAuthLauncher,
} from './oauth-launchers/contract.js';
import type { PersistedAuthStorage } from './persisted-auth-storage.js';

/** Construction inputs for the framework-agnostic hosted OAuth client. */
export type CreateOAuthAppAuthConfig = {
	/**
	 * Epicenter API origin. Defaults to the production API and is used for
	 * relative API paths, OAuth refresh/revoke routes, and session verification.
	 */
	baseURL?: string;
	/** Public OAuth client id registered for this runtime. */
	clientId: string;
	/** Durable storage for the single persisted auth cell. */
	persistedAuthStorage: PersistedAuthStorage;
	/**
	 * Runtime-specific sign-in transport. It either returns a token grant or
	 * reports that control moved to a later redirect or deep-link callback.
	 *
	 * A launcher that can consume that callback ({@link CallbackOAuthLauncher})
	 * is what makes the composed client a {@link CallbackAuthClient}. The
	 * overloads below read exactly this.
	 */
	launcher: OAuthLauncher;
	/**
	 * Fetch implementation for session verification, refresh, revoke, and local
	 * authenticated resource calls.
	 */
	fetch?: AuthFetch;
	/**
	 * WebSocket constructor. Tests and non-browser runtimes inject this because
	 * browsers do not allow request headers during WebSocket upgrades.
	 */
	WebSocket?: typeof WebSocket;
	/** Clock used for refresh-skew checks and grant parsing. */
	now?: () => number;
	/** Library logger for subscriber and refresh failures. */
	log?: Logger;
};

export function createOAuthAppAuth(
	config: CreateOAuthAppAuthConfig & { launcher: CallbackOAuthLauncher },
): CallbackAuthClient;
export function createOAuthAppAuth(
	config: CreateOAuthAppAuthConfig,
): AuthClient;
/**
 * Compose one hosted OAuth credential authority with local HTTP and WebSocket
 * transports. Application bytes stay in the injected browser-compatible
 * implementations; the authority supplies only transient bearer grants. The
 * cached principal remains available for offline workspace boot, while server
 * access fails closed until `/api/session` verifies the current credential.
 *
 * The launcher decides whether the result can finish an OAuth callback, and the
 * overloads above say so statically. A launcher that completes inline (the
 * extension web-auth flow) yields a plain `AuthClient` with no `completeSignIn`
 * on it at all, rather than one that would have to refuse the call.
 */
export function createOAuthAppAuth({
	baseURL = EPICENTER_API_URL,
	clientId,
	persistedAuthStorage,
	launcher,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	WebSocket: WebSocketImpl = globalThis.WebSocket,
	now = Date.now,
	log,
}: CreateOAuthAppAuthConfig): AuthClient {
	const authority = createOAuthCredentialAuthority(
		{ persistedAuthStorage, launcher, fetch: fetchImpl, log },
		{ baseURL, clientId, now },
	);
	let account = createOAuthAccount(authority, {
		fetch: fetchImpl,
		WebSocket: WebSocketImpl,
	});
	let state: AuthState = projectState();
	function projectState(): AuthState {
		const identity = authority.snapshot.state;
		if (identity.status === 'signed-out' || account === null)
			return { status: 'signed-out' };
		return { status: identity.status, account };
	}
	const stop = authority.onStateChange(() => {
		const identity = authority.snapshot.state;
		if (identity.status === 'signed-out') account = null;
		else
			account ??= createOAuthAccount(authority, {
				fetch: fetchImpl,
				WebSocket: WebSocketImpl,
			});
		state = projectState();
	});
	return {
		get state() {
			return state;
		},
		connection: {
			baseURL,
			get status() {
				return 'connected' as const;
			},
			onChange() {
				return () => undefined;
			},
		},
		onStateChange(fn) {
			return authority.onStateChange(() => fn(state));
		},
		startSignIn() {
			return authority.startSignIn();
		},
		...(authority.completeSignIn === undefined
			? {}
			: { completeSignIn: authority.completeSignIn }),
		signOut() {
			return authority.signOut();
		},
		getProfile() {
			return (
				account?.getProfile() ??
				Promise.resolve(AuthError.ProfileUnavailable({ cause: 'Signed out.' }))
			);
		},
		[Symbol.dispose]() {
			authority[Symbol.dispose]();
			stop();
		},
	};
}
