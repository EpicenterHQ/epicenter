/**
 * Seed the first-party OAuth client rows this deployment validates against.
 *
 * Better Auth's oauth-provider reads client metadata (redirect URIs, PKCE,
 * scopes) from the `oauth_client` table at /authorize and /token, so the rows
 * must exist before any OAuth flow works (CLI login, dashboard sign-in). The
 * `cachedTrustedClients` config Set only governs consent-skip and CRUD
 * immutability, not metadata, so every deployment has to seed these rows. They
 * are a projection of code (`buildTrustedOAuthClients`, the single source of
 * truth), so this runs at deploy time, never in the request path. One
 * transaction deletes the explicitly retired first-party rows and upserts the
 * retained rows, making each run an idempotent reconciliation against
 * `baseURL`.
 *
 *   bun run oauth:seed:local     seed the local dev database
 *   bun run oauth:seed:remote    seed production (wrapped with Infisical)
 *
 * The connection and the upsert live here in `apps/api`, not in
 * `@epicenter/server`, so `pg` and the drizzle query-builder graph stay out of
 * the worker's module and type programs. The row shape and the trusted-client
 * invariant come from `projectTrustedOAuthClientToRow` in
 * `@epicenter/constants/oauth-seed` (beside `buildTrustedOAuthClients`, its
 * input), so this script never imports the request-path auth barrel.
 *
 * The upsert is raw parameterized SQL rather than a drizzle query: the
 * `oauth_client` table object is built against `@epicenter/server`'s
 * `drizzle-orm` copy, which bun materializes separately from `apps/api`'s copy
 * (peer-differentiated), so a drizzle query here would not typecheck. Raw SQL
 * needs no table object and dodges that split.
 *
 * `SEED_TARGET=prod` selects the canonical cloud origin; otherwise the local
 * dev origin. The connection string comes from `DATABASE_URL` (Infisical /ops
 * in prod) or the committed local default, matching `drizzle.config.ts`.
 */
import { APPS, localUrl } from '@epicenter/constants/apps';
import {
	buildTrustedOAuthClients,
	projectTrustedOAuthClientToRow,
} from '@epicenter/constants/oauth-seed';
import pg from 'pg';
import { LOCAL_DATABASE_URL } from '../wrangler-config';

const baseURL =
	process.env.SEED_TARGET === 'prod' ? APPS.API.url : localUrl(APPS.API);
const connectionString = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

type SeedDatabase = {
	query(sql: string, values?: unknown[]): Promise<unknown>;
};

const RETIRED_FIRST_PARTY_OAUTH_CLIENT_IDS = [
	'epicenter-opensidian',
	'epicenter-tab-manager',
	'epicenter-vocab',
] as const;

const DELETE_RETIRED = `
	DELETE FROM oauth_client
	WHERE client_id = ANY($1::text[])
`;

const UPSERT = `
	INSERT INTO oauth_client (
		id, client_id, disabled, skip_consent, scopes, created_at, updated_at,
		name, redirect_uris, token_endpoint_auth_method, grant_types,
		response_types, public, type, require_pkce
	)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
	ON CONFLICT (client_id) DO UPDATE SET
		disabled = EXCLUDED.disabled,
		skip_consent = EXCLUDED.skip_consent,
		scopes = EXCLUDED.scopes,
		updated_at = EXCLUDED.updated_at,
		name = EXCLUDED.name,
		redirect_uris = EXCLUDED.redirect_uris,
		token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
		grant_types = EXCLUDED.grant_types,
		response_types = EXCLUDED.response_types,
		public = EXCLUDED.public,
		type = EXCLUDED.type,
		require_pkce = EXCLUDED.require_pkce
`;

export async function reconcileTrustedOAuthClients(
	database: SeedDatabase,
	baseURL: string,
) {
	const clients = buildTrustedOAuthClients(baseURL);
	await database.query('BEGIN');
	try {
		await database.query(DELETE_RETIRED, [
			[...RETIRED_FIRST_PARTY_OAUTH_CLIENT_IDS],
		]);
		for (const trustedClient of clients) {
			const row = projectTrustedOAuthClientToRow(trustedClient);
			await database.query(UPSERT, [
				row.id,
				row.clientId,
				row.disabled,
				row.skipConsent,
				row.scopes,
				row.createdAt,
				row.updatedAt,
				row.name,
				row.redirectUris,
				row.tokenEndpointAuthMethod,
				row.grantTypes,
				row.responseTypes,
				row.public,
				row.type,
				row.requirePKCE,
			]);
		}
		await database.query('COMMIT');
	} catch (error) {
		await database.query('ROLLBACK');
		throw error;
	}
	return clients.length;
}

if (import.meta.main) {
	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		const clientCount = await reconcileTrustedOAuthClients(client, baseURL);
		console.log(
			`Reconciled ${clientCount} first-party OAuth client(s) for ${baseURL}`,
		);
	} finally {
		await client.end();
	}
}
