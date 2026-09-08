/**
 * @epicenter/server
 *
 * One shared Hono library, two deployables (ADR-0075): the hosted Epicenter
 * Cloud (many Better Auth users resolving to principals) and the self-hosted
 * single-partition instance (one pinned `principals/instance` partition behind
 * one operator bearer).
 *
 * Deployments construct the server app, resolve requests to principals, then
 * mount each reusable surface with the matching `mount*` primitive. Each
 * primitive owns its auth wiring; the deployment passes only auth and any
 * deployment policies (e.g. cloud billing middleware).
 * Sub-apps declare full URLs (including the `/api` prefix where
 * applicable). See `apps/api/worker/index.ts` for the cloud composition.
 */

// The single-partition instance's bearer resolver (self-host; ADR-0075). The
// deployment injects `createEnvTokenResolver(secret)` as its `ResolveBearerPrincipal`.
// The pure generator + boot entropy gate (`generateInstanceToken`
// / `assertStrongToken`) live in `@epicenter/auth`.
export { createEnvTokenResolver } from './auth/instance-token.js';
// The bearer resource-boundary error union the resolver emits (401
// `InvalidToken` / 503 `ServerError`). Re-exported so a deployment's own bearer
// resolver (e.g. `apps/api`'s dev auth) returns the same variants the request
// path expects, without reaching into the auth module directly.
export { OAuthError } from './auth/oauth-errors.js';
export { connectHyperdriveDb } from './db/backends/cloudflare.js';
// Database concern (cloud-only). `createDb(client)` wraps a connected pg
// client/pool in drizzle with the auth schema; a cloud entry hands the result to
// `mountCloudDb`. The Cloudflare per-request `pg.Client` over Hyperdrive comes from
// `connectHyperdriveDb`; a Bun host builds its own `pg.Pool` inline.
export { createDb, type Db } from './db/create-db.js';
export {
	deleteStorageObservations,
	listStorageObservations,
	type StorageObservation,
	type StorageSourceKind,
	upsertStorageObservation,
} from './db/storage-data.js';
// An opt-in burn-rate cap for the inference `policies` seam: caps requests per
// principal partition so a shared house key cannot be run up unbounded (ADR-0076).
export { rateLimit } from './middleware/rate-limit.js';
// Protected mounts use requireBearerPrincipal with the deployment's resolver:
// database-backed sessions on the cloud, operator tokens on an instance.
export {
	requireBearerPrincipal,
	resolveRequestSessionPrincipal,
} from './middleware/require-auth.js';
// The cloud-only relational layer, in two halves the cloud installs after
// `createServerApp` (both type against `CloudEnv`): `mountCloudAuth` builds the
// per-request Better Auth instance + the `authApp` surface; `mountCloudDb` runs
// the per-request Postgres connection + after-response drain. The single-partition
// instance calls NEITHER and composes no Better Auth or Postgres (ADR-0076).
// `CloudAuthBindings` is the Cloud-only auth env contract the cloud merges into
// its own boot validation and resolves through `resolveAuthSecrets` (ADR-0076).
export { CloudAuthBindings, mountCloudAuth } from './mount-cloud-auth.js';
export { mountCloudDb } from './mount-cloud-db.js';
// Reusable surfaces. Each `mount*` bundles auth + the route mount, accepting
// only the deployment-controlled knobs (auth choice, optional policies). The
// cloud's Better Auth surface (sessions, social sign-in, `c.var.auth`) is bundled into
// `mountCloudAuth`; an instance composes none of it (ADR-0075).
export { blobPrincipalPrefix, storeAuthorityName } from './principal.js';
export { mountBlobsApp, resolveDeploymentBlobStore } from './routes/blobs.js';
export { mountInferenceApp } from './routes/inference.js';
export { mountSessionApp } from './routes/session.js';
export { mountTranscriptionApp } from './routes/transcription.js';
// Parent app. Wires the portable per-request lifecycle (origin + trust, CORS,
// CSRF) and returns the `Hono` every surface mounts onto. It takes one
// `Identity` (who this deployment is on the web). The cloud's db + Better Auth are
// NOT here; the cloud adds them via `mountCloudDb` + `mountCloudAuth`.
export { createServerApp } from './server-app.js';
// Binding contract: the portable env the library reads from `c.env`, as both
// the arktype schema (value) and its inferred type (same name). Each deployment
// proves its own Env against it (extends in apps/self-host, satisfies in
// apps/api); a Bun host validates `process.env` with the schema at boot.
export { ServerBindings } from './server-bindings.js';
export { StoreAuthority } from './store-sync/authority.js';
export { GenerationsLedger } from './store-sync/generations.js';
export {
	type GenerationsLedgerStub,
	mountStoreSyncApp,
	type ResolveStore,
	type StoreAuthorityStub,
} from './store-sync/mount.js';
// Public Hono context types: the portable `Env` (both deployments), the cloud's
// `CloudEnv` (Env + Better Auth/Postgres state), and the `ResolveBearerPrincipal<E>`
// seam the deployment closes its auth wrappers over.
export type {
	CloudEnv,
	Env,
	ResolveBearerPrincipal,
} from './types.js';
