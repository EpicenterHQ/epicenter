import type { AuthState } from '@epicenter/identity';
import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';
import type { Principal } from './auth-types.js';

export type { AuthState };

/**
 * Fetch-compatible transport used by auth-owned HTTP calls.
 *
 * Consumers usually pass `auth.fetch` into API clients. Tests and machine auth
 * inject this shape so the auth runtime can exercise refresh, revoke, and
 * bearer attach without depending on global `fetch`.
 */
export type AuthFetch = (
	input: Request | string | URL,
	init?: RequestInit,
) => Promise<Response>;

/**
 * The one deployment this client talks to (ADR-0069: privacy is which
 * deployment runs the program). Fixed at construction by the factory that
 * built the client, so it is the single runtime owner of the hosted vs
 * self-hosted fact: UI branches on `deployment.kind` instead of re-deriving
 * the mode from the persisted {@link InstanceSetting}.
 *
 * `baseURL` is the origin (optionally with a path prefix) of the API this
 * client signs into. Client-side partitioning (local storage keys,
 * BroadcastChannel names) scopes by `(server, principalId)` with it, so two
 * signed-in deployments on the same machine stay distinct.
 *
 * Only the self-hosted arm carries a {@link InstanceConnection}: that client
 * verifies a static bearer against a remote instance at boot, a lifecycle
 * hosted OAuth does not have (its identity resolves through the persisted
 * grant, and `/api/session` verification gates each request instead).
 */
export type Deployment =
	| { kind: 'hosted'; baseURL: string }
	| { kind: 'self-hosted'; baseURL: string; connection: InstanceConnection };

/**
 * Whether the configured self-hosted instance has accepted this client's
 * token in this runtime. Boot identity is optimistic (`signed-in` the moment
 * a token is held, ADR-0075) and most outcomes leave it untouched: an
 * unreachable instance keeps the client signed-in for local-first work, and
 * only a rejected token drops {@link AuthState} to `signed-out`. This status
 * is the separate fact a UI reads to explain the connection.
 *
 * `rejected`: the instance answered and refused the token (401/403).
 * `unreachable`: no usable answer (offline, wrong origin, or a box that did
 * not respond like an Epicenter server).
 */
export type InstanceConnectionStatus =
	| 'connecting'
	| 'connected'
	| 'unreachable'
	| 'rejected';

/**
 * Observable {@link InstanceConnectionStatus}. `onChange` does not replay the
 * current value, mirroring {@link AuthClient.onStateChange}; read `status`
 * once before subscribing when the boot value matters (the Svelte reactive
 * wrapper does).
 */
export type InstanceConnection = {
	get status(): InstanceConnectionStatus;
	onChange(fn: (status: InstanceConnectionStatus) => void): () => void;
};

export type AuthClient = {
	state: AuthState;
	/**
	 * The deployment this client talks to: its kind, its `baseURL`, and (for a
	 * self-hosted instance) the live connection status. Fixed at construction.
	 */
	deployment: Deployment;
	/**
	 * Subscribe to future state changes.
	 *
	 * Read `state` once before registering when bootstrap state matters. The
	 * listener does not replay the current state, which keeps subscriptions from
	 * accidentally duplicating synchronous boot logic.
	 */
	onStateChange(fn: (state: AuthState) => void): () => void;
	/**
	 * Start the runtime's sign-in flow.
	 *
	 * Use this from UI or CLI commands that can hand control to the configured
	 * launcher. Completion means the launcher finished its work, not that a page
	 * navigation happened; callers should observe `state` for the durable signed
	 * in signal.
	 */
	startSignIn(): Promise<Result<undefined, AuthError>>;
	/**
	 * Clear local auth and revoke the refresh token when the server is reachable.
	 *
	 * Use this for explicit user logout. The local persisted cell is removed
	 * first, so local record access stops depending on whether the best-effort
	 * revoke request succeeds.
	 */
	signOut(): Promise<Result<undefined, AuthError>>;
	/**
	 * Fetch an API resource through the auth-owned credential boundary.
	 *
	 * Use this instead of attaching credentials yourself. Each client supplies
	 * its own credential and surfaces auth failures back into `state`; the
	 * credential and refresh behavior depend on the model (the OAuth client
	 * verifies `/api/session` and attaches a refreshed bearer; the same-origin
	 * cookie client sends the session cookie). See each factory for specifics.
	 */
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	/**
	 * Read the signed-in user's profile (`/api/session`) through the credential
	 * boundary.
	 *
	 * Presentational identity (the email) is fetched on demand by the surface
	 * that displays it, never persisted or carried on `state`: `state` holds only
	 * the principal id, which is offline-useful and license-clean (see
	 * `@epicenter/identity` `AuthState` and `PersistedAuth`). Account UI calls
	 * this when it renders the user; remote replica attachment reads
	 * `principalId` off `state`.
	 */
	getProfile(): Promise<Result<Principal, AuthError>>;
	[Symbol.dispose](): void;
};

/**
 * An {@link AuthClient} that can also open authenticated WebSockets for cloud
 * sync. Only credential models that carry a bearer can do this: the OAuth/PKCE
 * client ({@link createOAuthAppAuth}) implements it, while the same-origin
 * cookie client ({@link createSameOriginCookieAuth}) is a plain `AuthClient`
 * with no `openWebSocket`, because a same-origin cookie cannot carry the bearer
 * subprotocol the rooms route requires.
 *
 * Authenticated record, document, room, and relay transports require a
 * `SyncAuthClient`, so passing a cookie client where a bearer WebSocket is
 * needed is a compile error rather than a runtime throw.
 */
export type SyncAuthClient = AuthClient & {
	/**
	 * Open a WebSocket using the same bearer boundary as `fetch`.
	 *
	 * Browsers cannot set `Authorization` on WebSocket upgrades, so the token is
	 * carried as an Epicenter bearer subprotocol; the rooms route extracts it at
	 * the upgrade and the server echoes only the main subprotocol back.
	 *
	 * Resolves only with a credentialed socket. When no usable bearer can be
	 * attached it rejects with an `OpenWebSocketDenial` (`@epicenter/sync`)
	 * instead of opening a socket doomed to a server 4401: `'permanent'`
	 * (signed out, reauth required) means only an auth state change can help;
	 * `'transient'` means verification was unreachable and a retry may
	 * succeed. Waits for in-flight machine work (token refresh, `/api/session`
	 * verification), never for a human.
	 */
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
};
