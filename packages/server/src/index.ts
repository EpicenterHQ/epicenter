/**
 * @epicenter/server
 *
 * One shared Hono library for `apps/api`, which runs it on two runtimes: the
 * Cloudflare Worker (`worker/index.ts`) and Bun with Postgres (`server.ts`, the
 * self-host path). Both resolve Better Auth users to principals.
 *
 * Deployments construct the server app, resolve requests to principals, then
 * mount each reusable surface with the matching `mount*` primitive. Each
 * primitive owns its auth wiring; the deployment passes only auth and any
 * deployment policies (e.g. cloud billing middleware).
 * Sub-apps declare full URLs (including the `/api` prefix where
 * applicable). See `apps/api/worker/index.ts` for the cloud composition.
 */

// The OAuth 2.1 authorization server (ADR-0549): its shared policy, the
// first-party registrations a deployment writes, and the one resource check.
export { workerClientMetadataFetch } from './auth/client-metadata-fetch.js';
// Hosted auth routes are mounted separately from request context creation.
export { CloudAuthBindings } from './auth/create-auth.js';
// The bearer resource-boundary error union the resolver emits (401
// `InvalidToken` / 503 `ServerError`). Re-exported so a deployment's own bearer
// resolver (e.g. `apps/api`'s dev auth) returns the same variants the request
// path expects, without reaching into the auth module directly.
export { OAuthError } from './auth/oauth-errors.js';
export {
	OAUTH_SCOPES,
	type OAuthAudiences,
	type OAuthScope,
	oauthResourceInputs,
} from './auth/oauth-policy.js';
export {
	type FirstPartyClient,
	firstPartyClientRow,
	registerFirstPartyClients,
} from './auth/oauth-registrations.js';
export {
	type AccountAccess,
	authorizeAccountRequest,
	authorizeResourceRequest,
	protectedResourceMetadataUrl,
	type ResourceAccess,
	type ResourceRefusal,
	readAccessToken,
} from './auth/resource-access.js';
export { createCloudContextMiddleware } from './create-cloud-context-middleware.js';
export { connectHyperdriveDb } from './db/backends/cloudflare.js';
// Cloud database handles: Hyperdrive uses a per-request client; Bun uses a pool.
export { createDb, type Db } from './db/create-db.js';
// Protected mounts: an access token for a resource, the session cookie for
// account management on the authorization server's own pages (ADR-0549), and
// the dev entry's bearer seam.
export {
	requireAccessToken,
	requireBearerPrincipal,
	requireSessionCookie,
} from './middleware/require-auth.js';
export {
	NAMESPACE_ROLES,
	type NamespaceOperation,
	type NamespaceRole,
	roleAllows,
} from './namespace-roles.js';
// Hosted repositories as rows (ADR-0546): the manage role's rename and move,
// each leaving an alias. No route mounts them yet.
export {
	changeRepository,
	moveRepository,
	RepositoryChangeError,
	renameRepository,
} from './repositories.js';
// Reusable surfaces. Each `mount*` bundles auth + the route mount, accepting
// only the deployment-controlled knobs (auth choice, optional policies). The
// Better Auth endpoints are mounted by mountAuthRoutes.
export { mountAuthRoutes } from './routes/auth.js';
export {
	type HostedBlobStore,
	mountPersonalAuthorityBlobs,
} from './routes/authority-blobs.js';
export {
	type GitHost,
	type GitRequest,
	type GitService,
	mountGitHost,
} from './routes/git.js';
export { mountInferenceApp } from './routes/inference.js';
// The folder MCP server at the MCP audience (ADR-0550).
export { mountMcpServer } from './routes/mcp.js';
export { mountSessionApp } from './routes/session.js';
export { mountTranscriptionApp } from './routes/transcription.js';
export { resolveDeploymentBlobStore } from './s3-blob-store.js';
// Parent app. Wires the portable per-request lifecycle (origin + trust, CORS,
// CSRF) and returns the `Hono` every surface mounts onto. It takes one
// `Identity` (who this deployment is on the web). The cloud's db + Better Auth are
// NOT here; the cloud adds them via `createCloudContextMiddleware`.
export { createServerApp } from './server-app.js';
// Binding contract: the portable env the library reads from `c.env`, as both
// the arktype schema (value) and its inferred type (same name). Each deployment
// proves its own Env against it (`satisfies` in apps/api's Worker); a Bun host
// validates `process.env` with the schema at boot.
export { ServerBindings } from './server-bindings.js';
// Public Hono context types: the portable `Env` (both deployments), the cloud's
// `CloudEnv` (Env + Better Auth/Postgres state), and the `ResolveBearerPrincipal<E>`
// seam the deployment closes its auth wrappers over.
export type {
	CloudEnv,
	Env,
	ResolveBearerPrincipal,
} from './types.js';
