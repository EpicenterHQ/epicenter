import { PrincipalId } from '@epicenter/identity';
import { type } from 'arktype';

/**
 * The authenticated principal projected for Epicenter clients.
 *
 * Better Auth still owns its `user` table and session model. This projection is
 * the Epicenter principal used when a local replica attaches remotely. Hosted
 * Cloud principals include `email`; the self-hosted instance principal does
 * not.
 */
export const Principal = type({
	'+': 'delete',
	id: PrincipalId,
	'email?': 'string',
});

export type Principal = typeof Principal.infer;

/**
 * OAuth token grant. Persisted under `PersistedAuth.grant`.
 *
 * Server-access material: required to call `/api/*` online; offline-useless
 * on its own. Refresh tokens rotate on every successful refresh.
 */
export const OAuthTokenGrant = type({
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	/**
	 * Absolute access-token expiry as epoch milliseconds.
	 *
	 * Computed from the OAuth `expires_in` seconds returned with the token
	 * grant (`accessTokenExpiresAt = now() + expires_in * 1000`). Used only as
	 * a transport refresh hint: the resource server is still the source of
	 * truth for token validity, so this value is checked locally to decide
	 * when to refresh, never to authorize a request.
	 */
	accessTokenExpiresAt: 'number',
});

export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;

/**
 * The single persisted auth cell.
 *
 * Browser persists to localStorage, extension to chrome.storage.local, CLI
 * to a per-API-target file under the platform data directory (mode 0o600);
 * see {@link machineAuthFilePath}. All three cells validate against this
 * arktype, which satisfies StandardSchemaV1 natively via `~standard`, so it
 * plugs straight into Standard-Schema consumers like createPersistedState.
 * Profile data is intentionally absent; application surfaces fetch it when
 * they display it.
 *
 * The grant is server-access material. The principal id is the offline-useful
 * remote attachment identity, so the local replica retains its intended
 * principal when the network is unavailable.
 */
export const PersistedAuth = type({
	'+': 'delete',
	grant: OAuthTokenGrant,
	principalId: PrincipalId,
});

export type PersistedAuth = typeof PersistedAuth.infer;

/**
 * Canonical `/api/session` response shape. The single contract between the
 * API and every Epicenter auth client (browser, extension, CLI machine,
 * daemon).
 *
 * The session endpoint exposes Epicenter's resource-server projection, not
 * Better Auth's internal session shape.
 */
export const ApiSessionResponse = type({
	'+': 'delete',
	principalId: PrincipalId,
	'email?': 'string',
});

export type ApiSessionResponse = typeof ApiSessionResponse.infer;
