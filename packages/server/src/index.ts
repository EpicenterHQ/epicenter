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
 *
 * Everything here loads on both runtimes. `@epicenter/server/bun` adds the
 * modules a Worker cannot bundle (`node:child_process`, Node's address-pinned
 * fetch).
 */

// The OAuth 2.1 authorization server (ADR-0549): its shared policy, the
// first-party registrations a deployment writes, and the one resource check.
// Hosted auth routes are mounted separately from request context creation.
export { CloudAuthBindings } from './auth/create-auth.js';
export {
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
	authorizeResourceRequest,
	readAccessToken,
} from './auth/resource-access.js';
export { createCloudContextMiddleware } from './create-cloud-context-middleware.js';
// Cloud database handles: Hyperdrive uses a per-request client; Bun uses a pool.
export { createDb, type Db } from './db/create-db.js';
export type { GitObjects } from './git/objects.js';
export type { LfsStore } from './lfs/lfs-store.js';
// Protected mounts: an access token for a resource, and the session cookie for
// account management on the authorization server's own pages (ADR-0549).
export {
	requireAccessToken,
	requireSessionCookie,
} from './middleware/require-auth.js';
// Reusable surfaces. Each `mount*` bundles auth + the route mount, accepting
// only the deployment-controlled knobs (auth choice, optional policies). The
// Better Auth endpoints are mounted by mountAuthRoutes.
export { mountAuthRoutes } from './routes/auth.js';
export { type GitHost, mountGitHost } from './routes/git.js';
export { mountInferenceApp } from './routes/inference.js';
export { mountTranscriptionApp } from './routes/transcription.js';
// Parent app. Wires the portable per-request lifecycle (origin + trust, CORS)
// and returns the `Hono` every surface mounts onto. It takes one
// `Identity` (who this deployment is on the web). The cloud's db + Better Auth are
// NOT here; the cloud adds them via `createCloudContextMiddleware`.
export { createServerApp } from './server-app.js';
// Binding contract: the portable env the library reads from `c.env`, as both
// the arktype schema (value) and its inferred type (same name). Each deployment
// proves its own Env against it (`satisfies` in apps/api's Worker); a Bun host
// validates `process.env` with the schema at boot.
export { ServerBindings } from './server-bindings.js';
// Public Hono context types: the portable `Env` (both deployments) and the
// cloud's `CloudEnv` (Env + Better Auth/Postgres state).
export type { CloudEnv, Env } from './types.js';
