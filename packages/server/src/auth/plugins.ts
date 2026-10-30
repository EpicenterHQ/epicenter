import {
	oauthDeviceAuthorization,
	oauthProvider,
} from '@better-auth/oauth-provider';
import { passkey } from '@better-auth/passkey';
import type { BetterAuthOptions } from 'better-auth';
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

/** The authorization server's deployment inputs. */
export type OAuthServerConfig = {
	/** The drizzle handle grant targets check membership with. */
	db: Db;
	/** This deployment's token audiences. */
	audiences: OAuthAudiences;
};

/** The OAuth 2.1 authorization server (ADR-0549). */
export function oauthServerPlugins({ db, audiences }: OAuthServerConfig) {
	return [
		oauthProvider({
			// Opaque, hashed access tokens checked in the database on every
			// request: no jwt plugin, no JWKS table.
			disableJwtPlugin: true,
			loginPage: '/sign-in',
			consentPage: '/consent',
			scopes: [...OAUTH_SCOPES],
			grantTypes: ['authorization_code', 'refresh_token'],
			// Every client is a first-party row the deployment registers
			// (`registerFirstPartyClients`); no client registers itself.
			allowDynamicClientRegistration: false,
			resources: oauthResourceInputs(audiences),
			// An existing row is never rewritten, as `registerFirstPartyClients`
			// leaves it.
			resourceSeedMode: 'insertOnly',
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
	] satisfies NonNullable<BetterAuthOptions['plugins']>;
}

/**
 * Passkeys for signing in to the authorization server's own pages.
 * `createAuth` composes them with {@link oauthServerPlugins}. A session is no
 * resource credential (ADR-0549), so there is no `bearer()`: clients hold
 * access tokens the authorization server issues.
 */
export function authPlugins(apiBaseURL: string) {
	const origin = apiBaseURL.replace(/\/$/, '');
	const rpID = new URL(origin).hostname;
	return [passkey({ rpID, rpName: 'Epicenter', origin })] satisfies NonNullable<
		BetterAuthOptions['plugins']
	>;
}
