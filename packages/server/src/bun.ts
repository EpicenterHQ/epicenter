/**
 * @epicenter/server/bun: the Bun host surface.
 *
 * Same library, second runtime (ADR-0066). A Bun entry composes its server from
 * here (`createServerApp` + the `mount*` surface) and serves it with `Bun.serve`.
 * The hosted cloud's Bun bootstrap and the instance's Bun bootstrap each own
 * their own composition (`apps/api/server.ts`, `apps/self-host/server.ts`); the
 * library ships the parts, not a shared launcher (ADR-0075/0076). A Bun entry passes
 * {@link createBunRooms}'s `.rooms` as `createServerApp`'s `resolveRooms` (an
 * in-process registry over `bun:sqlite`, not a Durable Object); a cloud-on-Bun entry
 * additionally installs `mountCloudDb` with a `pg.Pool` checkout and a fire-and-forget
 * drain. Bun is the one non-Cloudflare runtime (ADR-0066): `bun:sqlite` is the
 * built-in synchronous engine the room update log needs, and `bun build
 * --compile` is what ships the self-host binary and the Tauri sidecar. There is
 * no Node backend; this code imports `bun:sqlite` and `Bun.serve` directly.
 *
 * This barrel re-exports everything the main barrel does EXCEPT the Cloudflare
 * pieces whose modules name `cloudflare:workers` or a Workers binding and so cannot
 * load in a Bun process: the `Room` Durable Object class, `createDurableObjectRooms`,
 * and `connectHyperdriveDb`. A Bun host supplies its own room and db concerns.
 */

export {
	type AttachRelayBunServer,
	createAttachRelayBunServer,
} from './attach-relay/bun-server.js';
// The AttachRelay (ADR-0115): the Bun WebSocket transport a desktop or
// self-hosted instance serves, plus the wire type its adapters speak. A
// self-hosted instance mounts it behind per-device grants (`mountAttachRelayApp`).
// The coordinator itself (`createAttachRelay`) stays package-internal, the way
// the room coordinator does; only its transport and mounts are public. The Cloud
// Durable Object transport (`createDurableObjectAttachRelay`, `AttachRelay`)
// lives in the main barrel instead: its module imports `cloudflare:workers` and
// cannot load in a Bun process.
export {
	RELAY_CLOSE,
	type RelayToHostFrame,
} from './attach-relay/contracts.js';
// The per-device attach grants (ADR-0115): the revocable allowlist that
// replaces the shared operator token on the attach surface. The store's
// `resolveBearerPrincipal` is the seam the attach mount closes over; the operator
// token administers the allowlist through `mountAttachGrantsApp`.
export {
	createDeviceGrantStore,
	type DeviceGrant,
	type DeviceGrantStore,
} from './attach-relay/device-grants.js';
// The authenticated self-host mount (ADR-0115): the attach relay behind the
// deployment's bearer gate, with the principal stamped server-side. On self-host
// the bearer is a per-device grant.
export { mountAttachGrantsApp } from './attach-relay/grants-app.js';
// The attach host directory (ADR-0115 clause 3): the closed
// `{ hostId, label, status }` entry a client discovers a host by, its
// three-valued liveness (`online`/`offline`/`unreachable`), and the read seam a
// discovery mount drives (`HostDirectoryReader`, satisfied by a Bun server's
// `.hostDirectory`). The entry schema stays closed so the directory can never
// grow into a capability registry.
export {
	type AttachHostDirectoryEntry,
	AttachHostStatus,
	type HostDirectoryReader,
} from './attach-relay/host-directory.js';
// The client's host-discovery mount (ADR-0115 clause 3): `GET /attach/hosts`
// behind the deployment's attach bearer, backend bound through
// `resolveHostDirectory`. Read-only and closed; a host publishes itself by
// connecting, never by a write route.
export { mountHostDirectoryApp } from './attach-relay/host-directory-app.js';
export { mountAttachRelayApp } from './attach-relay/mount.js';
export { ATTACH_RELAY_ROUTE } from './attach-relay/route.js';
// The single-partition instance's bearer resolver (self-host; ADR-0075): the
// `ResolveBearerPrincipal` a Bun instance injects (`createEnvTokenResolver(token)`).
// The pure generator + boot entropy gate (`generateInstanceToken` /
// `assertStrongToken`) live in `@epicenter/auth`.
export { createEnvTokenResolver } from './auth/instance-token.js';
// The OAuth resource-boundary error union the bearer resolver emits. Exported
// here too (it is not a Cloudflare module) so a Bun entry's dev bearer resolver
// gets it without importing the main barrel, which would drag in the `Room`
// Durable Object and its `cloudflare:workers` import.
export { OAuthError } from './auth/oauth-errors.js';
export { createDb } from './db/create-db.js';
export {
	listStorageObservations,
	type StorageObservation,
} from './db/storage-data.js';
export {
	type BunEpicenterSyncRuntime,
	createBunEpicenterSyncRuntime,
	mountBunEpicenterSyncApp,
} from './epicenter-sync/bun.js';
// Merge several Bun `WebSocketHandler`s onto one `Bun.serve`, dispatching each
// socket to its backend by a `surface` tag (rooms + attach relay on one port).
export { mergeBunWebSocketHandlers } from './merge-bun-websocket-handlers.js';
// An opt-in burn-rate cap for the inference `policies` seam (ADR-0076).
export { rateLimit } from './middleware/rate-limit.js';
export {
	requireBearerPrincipal,
	requireCookieOrBearerPrincipal,
	resolveRequestOAuthPrincipal,
} from './middleware/require-auth.js';
// The cloud-only relational layer (Better Auth on `c.var.auth` + the auth surface,
// and the Postgres lifecycle). A cloud-on-Bun entry calls `mountCloudAuth` +
// `mountCloudDb` once after `createServerApp`; the single-partition instance calls
// neither (ADR-0076). `CloudAuthBindings` is the Cloud-only auth env contract,
// merged into the cloud Bun host's boot validation.
export { CloudAuthBindings, mountCloudAuth } from './mount-cloud-auth.js';
export { mountCloudDb } from './mount-cloud-db.js';
// The Bun room backend: an in-process Rooms map + bun:sqlite update log,
// plus the Bun `websocket` handler and `bindServer` the entry wires. Its `.rooms`
// is what a Bun entry passes as `createServerApp`'s `resolveRooms`.
export { createBunRooms } from './room/backends/bun/registry.js';
export { mountBlobsApp } from './routes/blobs.js';
export { mountInferenceApp } from './routes/inference.js';
export { mountRoomsApp } from './routes/rooms.js';
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
