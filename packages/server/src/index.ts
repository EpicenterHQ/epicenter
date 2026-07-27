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

export {
	AttachRelay,
	createDurableObjectAttachRelay,
} from './attach-relay/cloudflare-do.js';
// The AttachRelay (ADR-0115): the endpoint-addressed relay that forwards live
// Super Chat bytes between two authenticated endpoints of one principal. The
// wire contract (the connect route and the frame delivered to a host) is the
// shared addressing vocabulary any transport or client speaks; the coordinator
// itself stays package-internal, the way the room coordinator does. On Cloud the
// transport is a Durable Object: `createDurableObjectAttachRelay` is the backend
// a deployment wires into `mountAttachRelayApp`'s `resolveRelay`, and the
// `AttachRelay` class is re-exported so a deployment's wrangler.jsonc can resolve
// `class_name: "AttachRelay"` against this entrypoint (the Bun transport lives in
// the `/bun` barrel instead). The relay forwards opaque bytes for one consumer,
// Super Chat attach (clause 4); it is never a routing product.
export {
	RELAY_CLOSE,
	type RelayToHostFrame,
} from './attach-relay/contracts.js';
export { mountAttachRelayApp } from './attach-relay/mount.js';
export { ATTACH_RELAY_ROUTE } from './attach-relay/route.js';
// The single-partition instance's bearer resolver (self-host; ADR-0075). The
// deployment injects `createEnvTokenResolver(secret)` as its `ResolveBearerPrincipal`.
// The pure generator + boot entropy gate (`generateInstanceToken`
// / `assertStrongToken`) live in `@epicenter/auth`.
export { createEnvTokenResolver } from './auth/instance-token.js';
// The OAuth resource-boundary error union the bearer resolver emits (401
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
export {
	createDurableObjectAccountAuthorities,
	EpicenterAuthority,
	mountCloudflareEpicenterSyncApp,
} from './epicenter-sync/cloudflare.js';
// An opt-in burn-rate cap for the inference `policies` seam: caps requests per
// principal partition so a shared house key cannot be run up unbounded (ADR-0076).
export { rateLimit } from './middleware/rate-limit.js';
// Deploy-time admin operations (OAuth client seeding) live in each
// deployment's own scripts (`apps/api` `oauth:seed:*`), not in this barrel, so
// `pg` and the drizzle query-builder graph stay out of the worker's module and
// type programs. The seed builds rows from `projectTrustedOAuthClientToRow` in
// `@epicenter/constants/oauth-seed` (beside `buildTrustedOAuthClients`, its
// input), so it never imports this request-path auth barrel.
//
// Auth middleware + the cloud's OAuth bearer resolver. A deployment passes one of
// these as the `auth` for each protected mount (the cloud passes
// `requireCookieOrBearerPrincipal`, an instance `requireBearerPrincipal`) and passes
// `resolveRequestOAuthPrincipal` as the cloud resolver; an instance passes its
// bearer resolver instead (ADR-0075).
export {
	requireBearerPrincipal,
	requireCookieOrBearerPrincipal,
	resolveRequestOAuthPrincipal,
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
// cloud's Better Auth surface (sessions, OAuth, `c.var.auth`) is bundled into
// `mountCloudAuth`; an instance composes none of it (ADR-0075).
export { blobPrincipalPrefix } from './principal.js';
// Re-export the Cloudflare Durable Object class so each deployment's
// wrangler.jsonc can resolve `class_name: "Room"` against this entrypoint.
export { Room } from './room/backends/cloudflare/durable-object.js';
// The Cloudflare runtime backends a deployment wires into `createServerApp`'s
// `resolveRooms` (the Durable Object room registry) and `mountCloudDb`'s `connect`
// (a per-request pg client over Hyperdrive). A Bun host uses `createBunRooms` and
// its own pool instead (the `@epicenter/server/bun` barrel omits both of these,
// since their modules name Cloudflare bindings).
export { createDurableObjectRooms } from './room/backends/cloudflare/registry.js';
export { mountBlobsApp, resolveDeploymentBlobStore } from './routes/blobs.js';
export { mountInferenceApp } from './routes/inference.js';
export { mountRoomsApp } from './routes/rooms.js';
export { mountSessionApp } from './routes/session.js';
export { mountTranscriptionApp } from './routes/transcription.js';
// Parent app. Wires the portable per-request lifecycle (origin + trust, CORS,
// CSRF, the rooms registry) and returns the `Hono` every surface mounts onto. It
// takes `resolveRooms` (the one runtime-specific portable concern) and an
// `Identity` (who this deployment is on the web). The cloud's db + Better Auth are
// NOT here; the cloud adds them via `mountCloudDb` + `mountCloudAuth`.
export { createServerApp } from './server-app.js';
// Binding contract: the portable env the library reads from `c.env`, as both
// the arktype schema (value) and its inferred type (same name). Each deployment
// proves its own Env against it (extends in apps/self-host, satisfies in
// apps/api); a Bun host validates `process.env` with the schema at boot.
export { ServerBindings } from './server-bindings.js';
// Public Hono context types: the portable `Env` (both deployments), the cloud's
// `CloudEnv` (Env + Better Auth/Postgres state), and the `ResolveBearerPrincipal<E>`
// seam the deployment closes its auth wrappers over.
export type {
	CloudEnv,
	Env,
	ResolveBearerPrincipal,
} from './types.js';
