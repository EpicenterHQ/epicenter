/**
 * The OAuth 2.1 authorization server's tables (ADR-0549), as Better Auth's
 * generator emits them for `@better-auth/oauth-provider` and its device
 * grant. Regenerate with `bun run auth:generate:remote` and move the OAuth
 * models here.
 *
 * Tokens are stored as SHA-256 hashes, never as the token. `reference_id` on a
 * token, a consent, or an approved device code is its grant target (`*` or
 * `ns:<id>`).
 */
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from 'drizzle-orm/pg-core';
import { session, user } from './auth';

export const oauthClient = pgTable(
	'oauth_client',
	{
		id: text('id').primaryKey(),
		clientId: text('client_id').notNull().unique(),
		clientSecret: text('client_secret'),
		clientDiscoveryId: text('client_discovery_id'),
		disabled: boolean('disabled').default(false),
		skipConsent: boolean('skip_consent'),
		enableEndSession: boolean('enable_end_session'),
		subjectType: text('subject_type'),
		sectorIdentifier: text('sector_identifier'),
		scopes: text('scopes').array(),
		clientCredentialsScopes: text('client_credentials_scopes')
			.array()
			.default([]),
		userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at'),
		updatedAt: timestamp('updated_at'),
		name: text('name'),
		uri: text('uri'),
		icon: text('icon'),
		contacts: text('contacts').array(),
		tos: text('tos'),
		policy: text('policy'),
		softwareId: text('software_id'),
		softwareVersion: text('software_version'),
		softwareStatement: text('software_statement'),
		redirectUris: text('redirect_uris').array().notNull(),
		postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
		backchannelLogoutUri: text('backchannel_logout_uri'),
		backchannelLogoutSessionRequired: boolean(
			'backchannel_logout_session_required',
		),
		frontchannelLogoutUri: text('frontchannel_logout_uri'),
		frontchannelLogoutSessionRequired: boolean(
			'frontchannel_logout_session_required',
		),
		tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
		applicationType: text('application_type'),
		jwks: text('jwks'),
		jwksUri: text('jwks_uri'),
		grantTypes: text('grant_types').array(),
		responseTypes: text('response_types').array(),
		requirePKCE: boolean('require_pkce'),
		dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
		referenceId: text('reference_id'),
		metadata: jsonb('metadata'),
	},
	(table) => [index('oauthClient_userId_idx').on(table.userId)],
);

export const oauthResource = pgTable('oauth_resource', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull().unique(),
	name: text('name').notNull(),
	accessTokenTtl: integer('access_token_ttl'),
	refreshTokenTtl: integer('refresh_token_ttl'),
	signingAlgorithm: text('signing_algorithm'),
	signingKeyId: text('signing_key_id'),
	allowedScopes: text('allowed_scopes').array(),
	customClaims: jsonb('custom_claims'),
	dpopBoundAccessTokensRequired: boolean(
		'dpop_bound_access_tokens_required',
	).default(false),
	disabled: boolean('disabled').default(false),
	createdAt: timestamp('created_at'),
	updatedAt: timestamp('updated_at'),
	policyVersion: integer('policy_version').default(1),
	metadata: jsonb('metadata'),
});

export const oauthClientResource = pgTable(
	'oauth_client_resource',
	{
		id: text('id').primaryKey(),
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: 'cascade' }),
		resourceId: text('resource_id')
			.notNull()
			.references(() => oauthResource.identifier, { onDelete: 'cascade' }),
		metadata: jsonb('metadata'),
		createdAt: timestamp('created_at'),
	},
	(table) => [
		uniqueIndex('oauthClientResource_clientId_resourceId_uidx').on(
			table.clientId,
			table.resourceId,
		),
		index('oauthClientResource_clientId_idx').on(table.clientId),
		index('oauthClientResource_resourceId_idx').on(table.resourceId),
	],
);

export const oauthRefreshToken = pgTable(
	'oauth_refresh_token',
	{
		id: text('id').primaryKey(),
		token: text('token').notNull().unique(),
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: 'cascade' }),
		// Generated as `set null`, which would turn a signed-out browser
		// session's tokens into detached ones. Signing out deletes them
		// (ADR-0549); keep `cascade` when regenerating.
		sessionId: text('session_id').references(() => session.id, {
			onDelete: 'cascade',
		}),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		referenceId: text('reference_id'),
		authorizationCodeId: text('authorization_code_id'),
		resources: text('resources').array(),
		requestedUserInfoClaims: text('requested_user_info_claims').array(),
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').notNull(),
		revoked: timestamp('revoked'),
		rotatedAt: timestamp('rotated_at'),
		rotationReplayResponse: text('rotation_replay_response'),
		rotationReplayExpiresAt: timestamp('rotation_replay_expires_at'),
		authTime: timestamp('auth_time'),
		acr: text('acr'),
		amr: text('amr').array(),
		confirmation: jsonb('confirmation'),
		scopes: text('scopes').array().notNull(),
	},
	(table) => [
		index('oauthRefreshToken_clientId_idx').on(table.clientId),
		index('oauthRefreshToken_sessionId_idx').on(table.sessionId),
		index('oauthRefreshToken_userId_idx').on(table.userId),
		index('oauthRefreshToken_authorizationCodeId_idx').on(
			table.authorizationCodeId,
		),
	],
);

export const oauthAccessToken = pgTable(
	'oauth_access_token',
	{
		id: text('id').primaryKey(),
		token: text('token').notNull().unique(),
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: 'cascade' }),
		// Generated as `set null`, which would turn a signed-out browser
		// session's tokens into detached ones. Signing out deletes them
		// (ADR-0549); keep `cascade` when regenerating.
		sessionId: text('session_id').references(() => session.id, {
			onDelete: 'cascade',
		}),
		userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
		referenceId: text('reference_id'),
		authorizationCodeId: text('authorization_code_id'),
		resources: text('resources').array(),
		requestedUserInfoClaims: text('requested_user_info_claims').array(),
		refreshId: text('refresh_id').references(() => oauthRefreshToken.id, {
			onDelete: 'cascade',
		}),
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').notNull(),
		revoked: timestamp('revoked'),
		confirmation: jsonb('confirmation'),
		scopes: text('scopes').array().notNull(),
	},
	(table) => [
		index('oauthAccessToken_clientId_idx').on(table.clientId),
		index('oauthAccessToken_sessionId_idx').on(table.sessionId),
		index('oauthAccessToken_userId_idx').on(table.userId),
		index('oauthAccessToken_authorizationCodeId_idx').on(
			table.authorizationCodeId,
		),
		index('oauthAccessToken_refreshId_idx').on(table.refreshId),
	],
);

export const oauthConsent = pgTable(
	'oauth_consent',
	{
		id: text('id').primaryKey(),
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: 'cascade' }),
		userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
		referenceId: text('reference_id'),
		resources: text('resources').array(),
		requestedUserInfoClaims: text('requested_user_info_claims').array(),
		scopes: text('scopes').array().notNull(),
		createdAt: timestamp('created_at').notNull(),
		updatedAt: timestamp('updated_at').notNull(),
	},
	(table) => [
		index('oauthConsent_clientId_idx').on(table.clientId),
		index('oauthConsent_userId_idx').on(table.userId),
	],
);

export const oauthClientAssertion = pgTable('oauth_client_assertion', {
	id: text('id').primaryKey(),
	expiresAt: timestamp('expires_at').notNull(),
});

export const deviceCode = pgTable(
	'device_code',
	{
		id: text('id').primaryKey(),
		deviceCode: text('device_code').notNull(),
		userCode: text('user_code').notNull(),
		userId: text('user_id'),
		expiresAt: timestamp('expires_at').notNull(),
		status: text('status').notNull(),
		lastPolledAt: timestamp('last_polled_at'),
		pollingInterval: integer('polling_interval'),
		clientId: text('client_id'),
		scope: text('scope'),
		resources: text('resources').array(),
		oauthClientId: text('oauth_client_id'),
		referenceId: text('reference_id'),
		authTime: timestamp('auth_time'),
		acr: text('acr'),
		amr: text('amr').array(),
	},
	(table) => [
		uniqueIndex('deviceCode_deviceCode_uidx').on(table.deviceCode),
		uniqueIndex('deviceCode_userCode_uidx').on(table.userCode),
	],
);
