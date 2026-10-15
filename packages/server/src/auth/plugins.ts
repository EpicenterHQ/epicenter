import { cimd } from '@better-auth/cimd';
import {
	type ClientMetadataResourceFetch,
	oauthDeviceAuthorization,
	oauthProvider,
} from '@better-auth/oauth-provider';
import { passkey } from '@better-auth/passkey';
import type { BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import type { Db } from '../db/create-db.js';
import { grantTarget, resolveConsentReferenceId } from './grant-target.js';
import {
	ACCESS_TOKEN_TTL_SECONDS,
	OAUTH_SCOPES,
	type OAuthAudiences,
	oauthResourceInputs,
	REFRESH_TOKEN_REUSE_INTERVAL_SECONDS,
	REFRESH_TOKEN_TTL_SECONDS,
	TOKEN_PREFIX,
} from './oauth-policy.js';
import { offlineDetach } from './offline-detach.js';
import { sessionHandoff } from './session-handoff.js';

/** The authorization server's deployment inputs. */
export type OAuthServerConfig = {
	/** The drizzle handle grant targets check membership with. */
	db: Db;
	/** This deployment's token audiences. */
	audiences: OAuthAudiences;
	/**
	 * The transport for client ID metadata documents. It must refuse redirects
	 * and non-public addresses: `@better-auth/cimd/node` on Bun, a
	 * `redirect: "manual"` fetch under `global_fetch_strictly_public` on Workers.
	 * Omit it and no client can identify itself by URL.
	 */
	clientMetadataFetch?: ClientMetadataResourceFetch;
};

/**
 * One CIMD plugin per transport. Its metadata cache lives in the plugin's
 * closure, and a Worker builds Better Auth per request, so the plugin must
 * outlive the request for the cache to mean anything (ADR-0549).
 */
const cimdPlugins = new WeakMap<
	ClientMetadataResourceFetch,
	ReturnType<typeof cimd>
>();
function cimdFor(fetchClientMetadataResource: ClientMetadataResourceFetch) {
	let plugin = cimdPlugins.get(fetchClientMetadataResource);
	if (!plugin) {
		plugin = cimd({
			fetchClientMetadataResource,
			metadataProfile: 'mcp-2026-07-28',
		});
		cimdPlugins.set(fetchClientMetadataResource, plugin);
	}
	return plugin;
}

/** The OAuth 2.1 authorization server (ADR-0549). */
export function oauthServerPlugins({
	db,
	audiences,
	clientMetadataFetch,
}: OAuthServerConfig) {
	return [
		oauthProvider({
			// Opaque, hashed access tokens checked in the database on every
			// request: no jwt plugin, no JWKS table.
			disableJwtPlugin: true,
			loginPage: '/sign-in',
			consentPage: '/consent',
			scopes: [...OAUTH_SCOPES],
			grantTypes: ['authorization_code', 'refresh_token'],
			// First-party clients are seeded by migration; third parties identify
			// themselves with a client ID metadata document.
			allowDynamicClientRegistration: false,
			resources: oauthResourceInputs(audiences),
			// Migrations seed the rows; a boot never rewrites one.
			resourceSeedMode: 'insertOnly',
			// A client discovered by its metadata document reaches only MCP.
			clientRegistrationDefaultResources: [audiences.mcp],
			accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
			refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
			refreshTokenReuseInterval: REFRESH_TOKEN_REUSE_INTERVAL_SECONDS,
			prefix: {
				opaqueAccessToken: TOKEN_PREFIX.access,
				refreshToken: TOKEN_PREFIX.refresh,
			},
			postLogin: {
				page: '/consent',
				// The target is chosen on the consent page itself, or defaults to
				// `*` for a first-party client; there is no separate page.
				shouldRedirect: () => false,
				consentReferenceId: resolveConsentReferenceId,
			},
		}),
		// RFC 8628 through the provider, so a device grant issues OAuth tokens.
		oauthDeviceAuthorization({ expiresIn: '10m', verificationUri: '/device' }),
		grantTarget({ db }),
		offlineDetach(),
		...(clientMetadataFetch ? [cimdFor(clientMetadataFetch)] : []),
	] satisfies NonNullable<BetterAuthOptions['plugins']>;
}

/**
 * The session plugins: signed session bearers, the session handoff, and
 * passkeys. `createAuth` composes them with {@link oauthServerPlugins}.
 */
export function authPlugins(
	apiBaseURL: string,
	callbacks: readonly string[] = [],
) {
	const origin = apiBaseURL.replace(/\/$/, '');
	const rpID = new URL(origin).hostname;
	return [
		// Session bearers and the session handoff stay until every client signs
		// in through the authorization server (ADR-0549, wave 2).
		bearer({ requireSignature: true }),
		sessionHandoff({
			origin,
			callbacks,
		}),
		passkey({ rpID, rpName: 'Epicenter', origin }),
	] satisfies NonNullable<BetterAuthOptions['plugins']>;
}
