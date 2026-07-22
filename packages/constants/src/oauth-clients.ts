/**
 * Public OAuth client ids and scopes every Epicenter first-party app presents
 * during sign-in.
 *
 * These are public PKCE client ids, not secrets: each identifies an app type,
 * not a user, machine, install, or credential, and every install of a given
 * app uses the same value. They are split out from the server-only trusted
 * client builders (see oauth-seed.ts) so a framework-agnostic client like
 * `@epicenter/auth` can import an id and the scopes without reaching the seed
 * layer or its `@better-auth/oauth-provider` types.
 */

/**
 * OAuth public client id for `epicenter auth login`.
 *
 * The CLI uses an out-of-band (OOB) authorization-code + PKCE flow against
 * the same `/auth/oauth2/token` endpoint the browser uses. After sign-in
 * on the hosted portal, Better Auth redirects to the API origin's
 * `/cli-callback`, which renders the one-time code; the user pastes
 * it into the terminal. This identifies the CLI app type, not a user,
 * machine, install, or secret. Every CLI install uses the same value.
 */
export const EPICENTER_CLI_OAUTH_CLIENT_ID = 'epicenter-cli';
export const EPICENTER_DESKTOP_OAUTH_CLIENT_ID = 'epicenter-desktop';
export const EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI =
	'epicenter://auth/callback';
export const EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID = 'epicenter-honeycrisp';
export const EPICENTER_HONEYCRISP_TAURI_OAUTH_REDIRECT_URI =
	'epicenter-honeycrisp://oauth/callback';
export const EPICENTER_WHISPERING_OAUTH_CLIENT_ID = 'epicenter-whispering';

export const EPICENTER_OAUTH_SCOPES = [
	'openid',
	'profile',
	'email',
	'offline_access',
] as const;

export const EPICENTER_OAUTH_SCOPE = EPICENTER_OAUTH_SCOPES.join(' ');
