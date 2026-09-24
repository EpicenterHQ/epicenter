/**
 * @epicenter/server/bun: the Bun host surface.
 *
 * Same library, second runtime (ADR-0066). A Bun entry composes its server from
 * here (`createServerApp` + the `mount*` surface) and serves it with `Bun.serve`.
 * The hosted cloud's Bun bootstrap and the instance's Bun bootstrap each own
 * their own composition (`apps/api/server.ts`, `apps/self-host/server.ts`); the
 * library ships the parts, not a shared launcher (ADR-0075/0076). A cloud-on-Bun
 * entry uses `createCloudContextMiddleware` with a shared `pg.Pool` and a
 * fire-and-forget drain on database-dependent routes. Bun is the one
 * non-Cloudflare runtime (ADR-0066):
 * `bun:sqlite` is the built-in synchronous engine the Epicenter authority needs,
 * and `bun build --compile` is what ships the self-host binary and the Tauri
 * sidecar. There is no Node backend; this code imports `bun:sqlite` and
 * `Bun.serve` directly.
 *
 * This barrel re-exports everything the main barrel does EXCEPT the Cloudflare
 * pieces whose modules name `cloudflare:workers` or a Workers binding and so cannot
 * load in a Bun process. A Bun host supplies its own db concerns.
 */

// Hosted auth routes are separate from the cloud request-context middleware.
// CloudAuthBindings is merged into the Bun host's boot validation.
export { CloudAuthBindings } from './auth/create-auth.js';
// The single-partition instance's bearer resolver (self-host; ADR-0075): the
// `ResolveBearerPrincipal` a Bun instance injects (`createEnvTokenResolver(token)`).
// The pure generator + boot entropy gate (`generateInstanceToken` /
// `assertStrongToken`) live in `@epicenter/auth`.
export { createEnvTokenResolver } from './auth/instance-token.js';
// The bearer resource-boundary error union the resolver emits. Exported
// here too (it is not a Cloudflare module) so a Bun entry's dev bearer resolver
// gets it without importing the main barrel, which would drag in the Cloudflare
// Durable Objects and their `cloudflare:workers` import.
export { OAuthError } from './auth/oauth-errors.js';
export { createCloudContextMiddleware } from './create-cloud-context-middleware.js';
export { createDb } from './db/create-db.js';
export {
	listStorageObservations,
	type StorageObservation,
} from './db/storage-data.js';
// An opt-in burn-rate cap for the inference `policies` seam (ADR-0076).
export { rateLimit } from './middleware/rate-limit.js';
export {
	requireBearerPrincipal,
	resolveRequestSessionPrincipal,
} from './middleware/require-auth.js';
export { mountAuthRoutes } from './routes/auth.js';
export { mountPersonalAuthorityBlobs } from './routes/authority-blobs.js';
export { mountInferenceApp } from './routes/inference.js';
export { mountSessionApp } from './routes/session.js';
export { mountTranscriptionApp } from './routes/transcription.js';
export { createServerApp } from './server-app.js';
// The portable env contract as both arktype schema (value) and inferred type;
// the Bun entry validates `process.env` against it at boot (merging its own
// process config and any secrets it re-requires).
export { ServerBindings } from './server-bindings.js';
// Public Hono context types: the portable `Env`, the cloud's `CloudEnv`, and the
// `ResolveBearerPrincipal<E>` seam the dev Bun entry closes its wrapper over for the smoke.
export type {
	CloudEnv,
	Env,
	ResolveBearerPrincipal,
} from './types.js';
