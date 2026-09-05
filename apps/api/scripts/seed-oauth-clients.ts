/**
 * Seed the first-party OAuth client rows this deployment validates against.
 *
 * Better Auth's oauth-provider reads client metadata (redirect URIs, PKCE,
 * scopes) from the `oauth_client` table at /authorize and /token, so the rows
 * must exist before any OAuth flow works. The `cachedTrustedClients` config Set
 * only governs consent-skip and CRUD immutability, not metadata, so every
 * deployment has to seed these rows. They are a projection of code
 * (`buildTrustedOAuthClients`, the single source of truth), so this runs at
 * deploy time, never in the request path. The upsert makes re-running
 * idempotent. Every trusted client owns its own callback surface (an app
 * origin, a Tauri deep link, an extension id), so the rows are the same for
 * every deployment; only the database this points at differs.
 *
 * After upserting, the script disables every id in `RETIRED_OAUTH_CLIENT_IDS`
 * (kept for audit, never deleted). The upsert alone cannot revoke a client
 * that left the trusted set: `epicenter-cli` was seeded while the deleted CLI
 * existed and would otherwise survive as valid client metadata at /authorize
 * and /token. The disable is idempotent, so re-running the seed is safe.
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
 * The connection string comes from `DATABASE_URL` (Infisical /ops in prod) or
 * the committed local default, matching `drizzle.config.ts`.
 */
import {
	RETIRED_OAUTH_CLIENT_IDS,
	buildTrustedOAuthClients,
	projectTrustedOAuthClientToRow,
} from '@epicenter/constants/oauth-seed';
import pg from 'pg';
import { LOCAL_DATABASE_URL } from '../wrangler-config';

const connectionString = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

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

const RETIRE = `
	UPDATE oauth_client
	SET disabled = true, skip_consent = false, updated_at = NOW()
	WHERE client_id = ANY($1)
`;

const client = new pg.Client({ connectionString });
await client.connect();
try {
	const clients = buildTrustedOAuthClients();
	for (const trustedClient of clients) {
		const row = projectTrustedOAuthClientToRow(trustedClient);
		await client.query(UPSERT, [
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
	console.log(`Seeded ${clients.length} first-party OAuth client(s)`);
	const retired = await client.query(RETIRE, [[...RETIRED_OAUTH_CLIENT_IDS]]);
	console.log(`Disabled ${retired.rowCount ?? 0} retired OAuth client(s)`);
} finally {
	await client.end();
}
