import * as oauth from 'oauth4webapi';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import { resolveQbCredentials } from './qb-credentials.ts';
import {
	type TokenGrantError,
	type TokenSet,
	tokenSetFromGrant,
} from './tokens.ts';

/**
 * QuickBooks OAuth2 built on `oauth4webapi` (the same client `@epicenter/account`
 * uses) plus `Bun.serve` for the localhost callback. The library owns the wire:
 * HTTP Basic client auth, the authorization-code and refresh-token grant
 * requests, and spec validation of the responses. We own only the QuickBooks
 * specifics: the localhost redirect, the non-standard `realmId` callback param,
 * and turning a validated grant into a {@link TokenSet}.
 */

export const OAuthError = defineErrors({
	MissingCredentials: ({ reason }: { reason: string }) => ({
		// `reason` is the resolver's message, which names the exact missing
		// environment-qualified variables (ADR-0108); append where to get the keys.
		message: `${reason} Get your Intuit app keys from your app at https://developer.intuit.com ("Keys & credentials").`,
		reason,
	}),
	AuthorizationDenied: ({
		error,
		description,
	}: {
		error: string;
		description: string;
	}) => ({
		message: `QuickBooks denied authorization: ${error}${description ? ` (${description})` : ''}`,
		error,
		description,
	}),
	TokenExchangeFailed: ({ cause }: { cause: unknown }) => ({
		message: `QuickBooks token exchange failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	Timeout: ({ ms }: { ms: number }) => ({
		message: `Timed out after ${ms}ms waiting for the OAuth callback.`,
		ms,
	}),
	ReauthRequired: ({ reason }: { reason: string }) => ({
		message: `Re-authentication required: ${reason}. Run "local-books auth".`,
		reason,
	}),
});
export type OAuthError = InferErrors<typeof OAuthError>;

/**
 * Boundaries the interactive {@link runAuthorizationFlow} needs beyond the
 * clock: a browser opener and a callback-wait budget. The non-interactive grant
 * exchanges ({@link refreshAccessToken}, {@link completeAuthorization}) need only
 * the clock, so they take a bare `now` rather than this bag.
 */
export type AuthorizationFlowOptions = {
	now: () => number;
	openBrowser?: (url: string) => void;
	log?: (message: string) => void;
	/** Callback wait budget; defaults to 5 minutes. */
	timeoutMs?: number;
};

type GrantResult = Promise<Result<TokenSet, OAuthError | TokenGrantError>>;

/** Hand-built server metadata; QuickBooks' endpoints are known constants. */
function authServer(config: AppConfig): oauth.AuthorizationServer {
	return {
		issuer: new URL(config.tokenUrl).origin,
		authorization_endpoint: config.authorizeUrl,
		token_endpoint: config.tokenUrl,
	};
}

/** Allow http for the mock token endpoint in tests. */
function httpOptions(config: AppConfig) {
	return {
		[oauth.allowInsecureRequests]:
			new URL(config.tokenUrl).protocol === 'http:',
	};
}

/**
 * Resolve the Intuit keyset for `config.environment` (ADR-0108), lazily, at the
 * OAuth/refresh site rather than eagerly in `loadConfig`, so a credential-free
 * verb never reads keys it does not use. The resolver throws when the qualified
 * names are absent; convert that into the {@link OAuthError} Result channel so
 * the loud "Missing QB_<ENV>_CLIENT_ID" message reaches the caller unchanged.
 */
function loadOAuthCredentials(
	config: AppConfig,
): Result<{ clientId: string; clientSecret: string }, OAuthError> {
	try {
		return Ok(resolveQbCredentials(config.environment));
	} catch (cause) {
		return OAuthError.MissingCredentials({
			reason: extractErrorMessage(cause),
		});
	}
}

export async function refreshAccessToken(
	config: AppConfig,
	token: TokenSet,
	now: () => number,
): GrantResult {
	const { data: credentials, error } = loadOAuthCredentials(config);
	if (error) return { data: null, error };
	const as = authServer(config);
	const client: oauth.Client = { client_id: credentials.clientId };
	try {
		const response = await oauth.refreshTokenGrantRequest(
			as,
			client,
			oauth.ClientSecretBasic(credentials.clientSecret),
			token.refreshToken,
			httpOptions(config),
		);
		const grant = await oauth.processRefreshTokenResponse(as, client, response);
		// Rotation: QuickBooks may omit refresh_token when the old one stays valid.
		return tokenSetFromGrant(grant, {
			realmId: token.realmId,
			environment: config.environment,
			now: now(),
			fallbackRefreshToken: token.refreshToken,
		});
	} catch (cause) {
		return OAuthError.TokenExchangeFailed({ cause });
	}
}

/**
 * Exchange a validated callback for a token set. Split out from
 * {@link runAuthorizationFlow} so the exchange is testable without binding the
 * localhost server: `validateAuthResponse` requires the callback parameters it
 * produced, so this is the smallest testable unit of the interactive flow. The
 * `realmId` is QuickBooks-specific and rides the callback alongside `code`.
 */
export async function completeAuthorization(
	config: AppConfig,
	{
		callbackUrl,
		state,
		codeVerifier,
	}: { callbackUrl: URL; state: string; codeVerifier?: string },
	now: () => number,
): GrantResult {
	const { data: credentials, error } = loadOAuthCredentials(config);
	if (error) return { data: null, error };
	const realmId = callbackUrl.searchParams.get('realmId');
	if (!realmId) {
		return OAuthError.AuthorizationDenied({
			error: 'invalid_callback',
			description: 'Missing realmId in callback.',
		});
	}
	const as = authServer(config);
	const client: oauth.Client = { client_id: credentials.clientId };
	try {
		const params = oauth.validateAuthResponse(as, client, callbackUrl, state);
		const response = await oauth.authorizationCodeGrantRequest(
			as,
			client,
			oauth.ClientSecretBasic(credentials.clientSecret),
			params,
			config.redirectUri,
			codeVerifier ?? oauth.nopkce,
			httpOptions(config),
		);
		const grant = await oauth.processAuthorizationCodeResponse(
			as,
			client,
			response,
		);
		return tokenSetFromGrant(grant, {
			realmId,
			environment: config.environment,
			now: now(),
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

function buildAuthorizeUrl(
	config: AppConfig,
	{
		state,
		codeChallenge,
		clientId,
	}: { state: string; codeChallenge: string; clientId: string },
): string {
	const url = new URL(config.authorizeUrl);
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', config.scopes.join(' '));
	url.searchParams.set('redirect_uri', config.redirectUri);
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

function defaultOpenBrowser(url: string): void {
	const cmd =
		process.platform === 'darwin'
			? ['open', url]
			: process.platform === 'win32'
				? ['cmd', '/c', 'start', '', url]
				: ['xdg-open', url];
	try {
		Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
	} catch {
		// Non-fatal: the URL is printed for manual paste.
	}
}

/**
 * Run the interactive authorization-code flow: spin up a localhost callback
 * server matching `redirectUri`, send the user to QuickBooks with PKCE, await
 * the redirect, then exchange the code. Returns the persisted token set.
 */
export async function runAuthorizationFlow(
	config: AppConfig,
	options: AuthorizationFlowOptions,
): GrantResult {
	const { data: credentials, error } = loadOAuthCredentials(config);
	if (error) return { data: null, error };

	const state = oauth.generateRandomState();
	const codeVerifier = oauth.generateRandomCodeVerifier();
	const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
	const redirect = new URL(config.redirectUri);
	// The public redirect host and the local listen port are decoupled: a public
	// HTTPS tunnel (Intuit production requires one, since it rejects localhost)
	// forwards to `callbackPort` here, which has no port of its own in the URL.
	const port = config.callbackPort ?? Number(redirect.port || '80');
	const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
	const log = options.log ?? (() => {});

	const { promise: callback, resolve } = Promise.withResolvers<URL | null>();
	const server = Bun.serve({
		port,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname !== redirect.pathname) {
				return new Response('Not found', { status: 404 });
			}
			resolve(url);
			return new Response(
				'<html><body><h2>local-books connected to QuickBooks.</h2><p>You can close this window and return to the terminal.</p></body></html>',
				{ headers: { 'content-type': 'text/html' } },
			);
		},
	});

	const authorizeUrl = buildAuthorizeUrl(config, {
		state,
		codeChallenge,
		clientId: credentials.clientId,
	});
	log('Opening your browser to authorize QuickBooks access...');
	log(`If it does not open, visit:\n  ${authorizeUrl}`);
	(options.openBrowser ?? defaultOpenBrowser)(authorizeUrl);

	const timeout = new Promise<URL | null>((resolveTimeout) => {
		setTimeout(() => resolveTimeout(null), timeoutMs);
	});
	const callbackUrl = await Promise.race([callback, timeout]);
	server.stop(true);
	if (!callbackUrl) return OAuthError.Timeout({ ms: timeoutMs });

	return completeAuthorization(
		config,
		{ callbackUrl, state, codeVerifier },
		options.now,
	);
}
