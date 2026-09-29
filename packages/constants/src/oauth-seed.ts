import type { SchemaClient } from '@better-auth/oauth-provider';
import { APPS, appOrigins } from '#apps';
import {
	EPICENTER_DESKTOP_OAUTH_CLIENT_ID,
	EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI,
	EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
	EPICENTER_HONEYCRISP_TAURI_OAUTH_REDIRECT_URI,
	EPICENTER_OAUTH_SCOPES,
	EPICENTER_VOCAB_OAUTH_CLIENT_ID,
	EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
} from './oauth-clients.js';

/**
 * Shape of one checked-in first-party public OAuth client.
 *
 * Better Auth calls server-side confidential clients `web`. Epicenter's
 * checked-in trusted clients are public PKCE clients
 * (`tokenEndpointAuthMethod: 'none'`, `public: true`, no client secret), so
 * Better Auth only accepts `native` and `user-agent-based` for this policy.
 * The API seed layer fills in the rest (PKCE required, consent skipped,
 * authorization-code flow, Epicenter scopes).
 *
 * `redirectUris` is the final resolved list, built by
 * {@link buildTrustedOAuthClients} from `APPS` plus each app's own
 * deep-link or extension callback.
 *
 * Field names stay spelled out instead of using `Pick` or a mapped type so
 * this file reads as config. The Better Auth indexed types keep the field
 * names tied to upstream without making the shape cryptic.
 */
export type TrustedOAuthClient = {
	clientId: NonNullable<SchemaClient['clientId']>;
	name: NonNullable<SchemaClient['name']>;
	type: Extract<
		NonNullable<SchemaClient['type']>,
		'native' | 'user-agent-based'
	>;
	redirectUris: readonly string[];
};

/**
 * Path every first-party app receives the OAuth callback at, on each of its
 * origins. A convention shared by all origin-owning apps, not a per-app
 * choice, so it lives here rather than as an {@link appCallbacks} argument.
 */
const AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * Every redirect URI for an app that owns its origin: each origin the app
 * answers on ({@link appOrigins}, i.e. dev plus prod) joined to
 * {@link AUTH_CALLBACK_PATH}. Used by Honeycrisp, Opensidian, and Vocab.
 */
function appCallbacks(app: {
	port: number;
	url: string;
	aliases?: readonly string[];
}): string[] {
	return appOrigins(app).map((origin) => `${origin}${AUTH_CALLBACK_PATH}`);
}

/**
 * Build the checked-in trusted public OAuth clients.
 *
 * Every client here owns its own callback surface: an app origin
 * ({@link appCallbacks}), a Tauri deep link, or an extension id. None of them
 * redirect back to the API origin, so the set is the same for every
 * deployment.
 *
 * The API `oauth:seed` deploy script calls this to upsert the client rows;
 * `authPlugins` calls it to derive the trusted-client-id set.
 */
export function buildTrustedOAuthClients() {
	// The same-origin dashboard SPA is not an OAuth client: it authenticates
	// with the first-party session cookie (see createSameOriginCookieAuth), so
	// it is deliberately absent from this trusted-client set.
	return [
		{
			clientId: EPICENTER_DESKTOP_OAUTH_CLIENT_ID,
			name: 'Epicenter Desktop',
			type: 'user-agent-based',
			redirectUris: [EPICENTER_DESKTOP_TAURI_OAUTH_REDIRECT_URI],
		},
		{
			clientId: EPICENTER_WHISPERING_OAUTH_CLIENT_ID,
			name: 'Whispering',
			type: 'user-agent-based',
			redirectUris: appCallbacks(APPS.WHISPERING),
		},
		{
			clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
			name: 'Honeycrisp',
			type: 'user-agent-based',
			redirectUris: [
				...appCallbacks(APPS.HONEYCRISP),
				EPICENTER_HONEYCRISP_TAURI_OAUTH_REDIRECT_URI,
			],
		},
		{
			clientId: EPICENTER_VOCAB_OAUTH_CLIENT_ID,
			name: 'Vocab',
			type: 'user-agent-based',
			redirectUris: appCallbacks(APPS.VOCAB),
		},
	] as const satisfies readonly TrustedOAuthClient[];
}

/**
 * OAuth client ids that must stay disabled.
 *
 * `epicenter-cli` was seeded before the terminal machine-auth surface was
 * deleted, and the seed script only upserts, so the row survives in every
 * database that was seeded while the CLI existed. It no longer skips consent
 * and its `/cli-callback` redirect target is gone, but Better Auth still reads
 * it as valid client metadata at `/authorize` and `/token` unless `disabled`
 * is true (see the `disabled` field on the `oauthClient` table: "indicates if
 * the current application is disabled"). The deploy seed disables these rows
 * after upserting the trusted set, keeping the row for audit instead of
 * deleting it. Never re-add an id from this list to
 * {@link buildTrustedOAuthClients}.
 */
export const RETIRED_OAUTH_CLIENT_IDS = ['epicenter-cli'] as const;

/**
 * Project a checked-in trusted client into Better Auth's `oauth_client` row.
 *
 * Used by the `apps/api` `oauth:seed` deploy script and by the auth tests that
 * need the exact row Better Auth stores. It owns the trusted-client invariant:
 * first-party apps are public PKCE clients (PKCE required, consent skipped,
 * authorization-code grant, the common Epicenter scopes).
 *
 * This lives beside {@link buildTrustedOAuthClients} (its input) rather than in
 * `@epicenter/server`, so the seed script reaches it without importing the
 * request-path auth barrel. The returned shape mirrors the `oauth_client`
 * table; the seed's parameterized `INSERT` is the write-time contract, so the
 * column list there must stay in sync with these fields.
 */
export function projectTrustedOAuthClientToRow(
	client: TrustedOAuthClient,
	now = new Date(),
) {
	return {
		id: client.clientId,
		clientId: client.clientId,
		disabled: false,
		skipConsent: true,
		scopes: [...EPICENTER_OAUTH_SCOPES],
		createdAt: now,
		updatedAt: now,
		name: client.name,
		redirectUris: [...client.redirectUris],
		tokenEndpointAuthMethod: 'none',
		grantTypes: ['authorization_code'],
		responseTypes: ['code'],
		public: true,
		type: client.type,
		requirePKCE: true,
	};
}
