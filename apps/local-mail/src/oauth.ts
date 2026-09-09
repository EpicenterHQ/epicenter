/**
 * Google OAuth for an application that is a page, not a process.
 *
 * The previous flow stood up a Bun loopback server, waited for Google to call
 * it, and shut it down. There is no Bun process any more (ADR-0317), so the
 * flow is the one a page performs: build the authorization URL, leave, and come
 * back to a redirect URI on this application's own route. What used to be a
 * server's lifetime is now two calls with the PKCE verifier carried between
 * them by the caller.
 *
 * **The account identity Google issues is `sub`, not the address.** Google
 * documents `sub` as stable for the life of the account while an email address
 * may change, so `sub` is recorded as `providerAccountId` and the address is
 * display metadata. Neither is Local Mail's own account id: that is the row id
 * Epicenter Data minted, which is what `device.secrets` is keyed by and what
 * every mail and intent row is partitioned by.
 */

import * as oauth from 'oauth4webapi';
import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { GmailClientIdentity, MailConfig } from './config.ts';

export const OAuthError = defineErrors({
	MissingCredentials: ({ reason }: { reason: string }) => ({
		message: reason,
		reason,
	}),
	TokenExchangeFailed: ({ cause }: { cause: unknown }) => {
		const message =
			cause instanceof oauth.ResponseBodyError
				? `${extractErrorMessage(cause)} (${
						cause.error_description
							? `${cause.error}: ${cause.error_description}`
							: cause.error
					}, HTTP ${cause.status})`
				: extractErrorMessage(cause);
		return {
			message: `Gmail token exchange failed: ${message}`,
			cause,
		};
	},
	AuthorizationDenied: ({
		error,
		description,
	}: {
		error: string;
		description: string;
	}) => ({
		message: `Gmail denied authorization: ${error}${description ? ` (${description})` : ''}`,
		error,
		description,
	}),
	IdentityMissing: ({ reason }: { reason: string }) => ({
		message: `Google did not identify the connected account: ${reason}.`,
		reason,
	}),
	ReauthRequired: ({ reason }: { reason: string }) => ({
		message: `Re-authentication required: ${reason}.`,
		reason,
	}),
});
export type OAuthError = InferErrors<typeof OAuthError>;

export type RefreshAccessError = InferError<
	typeof OAuthError.ReauthRequired | typeof OAuthError.TokenExchangeFailed
>;

/**
 * `gmail.modify` for the mailbox, and `openid email` for the two things that
 * name the account: the stable subject and the address to show.
 */
const SCOPES = [
	'https://www.googleapis.com/auth/gmail.modify',
	'openid',
	'email',
].join(' ');

/** What a page has to hold across the redirect to finish the exchange. */
export type AuthorizationRequest = {
	authorizeUrl: string;
	state: string;
	codeVerifier: string;
	redirectUri: string;
};

/** What Google told us about the account, plus the credential to keep. */
export type AuthorizedAccount = {
	/** Google's `sub`: stable for the life of the account. */
	providerAccountId: string;
	email: string;
	refreshToken: string;
	accessToken: string;
	accessTokenExpiresAt: string;
};

/** A live access token and the refresh token that is now current. */
export type RefreshedAccess = {
	accessToken: string;
	accessTokenExpiresAt: string;
	refreshToken: string;
};

/** Hand-built server metadata; Google's OAuth endpoints are known constants. */
function authServer(config: MailConfig): oauth.AuthorizationServer {
	return {
		// Google hosts the authorization issuer at accounts.google.com while the
		// token endpoint lives at oauth2.googleapis.com. The callback may include
		// `iss=https://accounts.google.com`; oauth4webapi validates it against
		// this field before the token exchange.
		issuer: new URL(config.authorizeUrl).origin,
		authorization_endpoint: config.authorizeUrl,
		token_endpoint: config.tokenUrl,
	};
}

/** Allow http for a mock token endpoint in tests. */
function httpOptions(config: MailConfig) {
	return {
		[oauth.allowInsecureRequests]:
			new URL(config.tokenUrl).protocol === 'http:',
	};
}

/**
 * Compose the URL to send a person to, and the two values to hold until they
 * come back.
 *
 * `prompt=consent` with `access_type=offline` is what makes Google issue a
 * refresh token rather than assuming the last one is still held. Without it a
 * reconnect returns an access token only, and background synchronization
 * silently stops working at the first expiry.
 */
export async function beginAuthorization({
	config,
	identity,
	redirectUri,
}: {
	config: MailConfig;
	identity: GmailClientIdentity;
	redirectUri: string;
}): Promise<AuthorizationRequest> {
	const state = oauth.generateRandomState();
	const codeVerifier = oauth.generateRandomCodeVerifier();
	const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
	const url = new URL(config.authorizeUrl);
	url.searchParams.set('client_id', identity.clientId);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', SCOPES);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('prompt', 'consent');
	return {
		authorizeUrl: url.toString(),
		state,
		codeVerifier,
		redirectUri,
	};
}

/** Redeem the code Google sent back, and read who it belongs to. */
export async function completeAuthorization({
	config,
	identity,
	request,
	callbackUrl,
	now,
}: {
	config: MailConfig;
	identity: GmailClientIdentity;
	request: AuthorizationRequest;
	callbackUrl: URL;
	now: () => number;
}): Promise<Result<AuthorizedAccount, OAuthError>> {
	const as = authServer(config);
	const client: oauth.Client = { client_id: identity.clientId };
	try {
		const params = oauth.validateAuthResponse(
			as,
			client,
			callbackUrl,
			request.state,
		);
		const response = await oauth.authorizationCodeGrantRequest(
			as,
			client,
			oauth.ClientSecretPost(identity.clientSecret),
			params,
			request.redirectUri,
			request.codeVerifier,
			httpOptions(config),
		);
		const grant = await oauth.processAuthorizationCodeResponse(
			as,
			client,
			response,
		);
		const claims = oauth.getValidatedIdTokenClaims(grant);
		if (claims === undefined) {
			return OAuthError.IdentityMissing({ reason: 'no id_token was returned' });
		}
		const email = typeof claims.email === 'string' ? claims.email : null;
		if (email === null) {
			return OAuthError.IdentityMissing({
				reason: 'the id_token carried no email claim',
			});
		}
		if (typeof grant.refresh_token !== 'string') {
			return OAuthError.IdentityMissing({
				reason: 'Google returned no refresh token, so nothing could sync later',
			});
		}
		return Ok({
			providerAccountId: claims.sub,
			email,
			refreshToken: grant.refresh_token,
			accessToken: grant.access_token,
			accessTokenExpiresAt: expiryOf(grant, now()),
		});
	} catch (cause) {
		if (cause instanceof oauth.AuthorizationResponseError) {
			return OAuthError.AuthorizationDenied({
				error: cause.error,
				description: cause.error_description ?? '',
			});
		}
		return OAuthError.TokenExchangeFailed({ cause });
	}
}

/**
 * Exchange the stored refresh token for a live access token.
 *
 * Google may omit `refresh_token` when the one it holds stays valid, so the
 * caller's token is threaded through as the answer in that case; the returned
 * `refreshToken` is always the one to store next.
 */
export async function refreshAccess({
	config,
	identity,
	refreshToken,
	now,
}: {
	config: MailConfig;
	identity: GmailClientIdentity;
	refreshToken: string;
	now: () => number;
}): Promise<Result<RefreshedAccess, RefreshAccessError>> {
	const as = authServer(config);
	const client: oauth.Client = { client_id: identity.clientId };
	try {
		const response = await oauth.refreshTokenGrantRequest(
			as,
			client,
			oauth.ClientSecretPost(identity.clientSecret),
			refreshToken,
			httpOptions(config),
		);
		const grant = await oauth.processRefreshTokenResponse(as, client, response);
		return Ok({
			accessToken: grant.access_token,
			accessTokenExpiresAt: expiryOf(grant, now()),
			refreshToken:
				typeof grant.refresh_token === 'string'
					? grant.refresh_token
					: refreshToken,
		});
	} catch (cause) {
		// A dead grant (revoked, or a Testing-mode client's seven-day test-user
		// expiry) arrives as an OAuth-style error rather than a returned value.
		// `invalid_grant` is the one worth distinguishing: it needs re-consent,
		// not a retry.
		if (
			cause instanceof oauth.ResponseBodyError &&
			cause.error === 'invalid_grant'
		) {
			return OAuthError.ReauthRequired({ reason: cause.error });
		}
		return OAuthError.TokenExchangeFailed({ cause });
	}
}

/** Google returns a relative lifetime; a stored token needs an absolute one. */
function expiryOf(grant: oauth.TokenEndpointResponse, now: number): string {
	const seconds = typeof grant.expires_in === 'number' ? grant.expires_in : 0;
	return new Date(now + seconds * 1000).toISOString();
}
