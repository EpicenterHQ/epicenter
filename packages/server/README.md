# `@epicenter/server`

The AGPL Hono library both deployables compose: `apps/api` (hosted Epicenter
Cloud, many principals behind Better Auth) and `apps/self-host` (the
single-partition instance reference, every valid bearer resolving to the
literal `instance` principal). A deployment builds the parent app with
`createServerApp`, supplies a bearer resolver, and mounts the surfaces it wants
with the matching `mount*` primitive. `apps/api/worker/index.ts` is the
composition to read first.

## The store authority

One data domain's store syncs to one Durable Object per
`(principalId, dataId, generation)`, named
`principals/<principalId>/data/<dataId>/generations/<generation>` (ADR-0292,
ADR-0298). Being signed in
on two devices is the whole sharing model: there is nothing to pair, invite, or
approve, and no identifier a client can supply that reaches another partition.

`mountStoreSyncApp` in `src/store-sync/mount.ts` owns the authenticated
upgrade. A WebSocket upgrade cannot set `Authorization`, so the credential
arrives as one `bearer.<token>` subprotocol and the 101 echoes only the main
one (ADR-0095). The principal is stamped from the resolved bearer and the
object is addressed by it, so this surface cannot be pointed at another
partition however the query is written.

`StoreAuthority` in `src/store-sync/authority.ts` is a thin adapter and nothing
more. Every rule about who has been sent what lives in `@epicenter/data/sync`,
so what is deployed and what the transport's own tests drive are the same
object. The authority reads nothing (ADR-0298): it holds opaque bytes, hands
them back in order, and folds acknowledged log prefixes. Nothing in it imports
Yjs or a workspace.

Rooms, the row-document HTTP pull, and the `src/epicenter-sync/` authority they
shared were deleted with the superseded data stack (ADR-0227), and the store
authority above is what replaced them.

## The other surfaces

Each `mount*` bundles its own auth wiring; the deployment passes only the auth
choice and any deployment policy.

| Mount | Source | Notes |
| --- | --- | --- |
| `mountSessionApp` | `src/routes/session.ts` | Reads the current principal back to a client. |
| `mountBlobsApp` | `src/routes/blobs.ts` | Content-addressed bytes, S3-compatible behind `resolveDeploymentBlobStore`. |
| `mountInferenceApp` | `src/routes/inference.ts` | Provider-backed inference, with `rateLimit` available as a policy. |
| `mountTranscriptionApp` | `src/routes/transcription.ts` | Provider-backed speech to text. |
| `mountCloudAuth`, `createCloudDbMiddleware` | `src/mount-cloud-auth.ts`, `src/create-cloud-db-middleware.ts` | Cloud only. Public HTML shells bypass relational setup. |

`mountCloudAuth` returns database/auth middleware for protected resource mounts.
Compose it before their authentication guards. The database middleware closes
its handle after queued work settles; public shells and unrelated 404s never
acquire one. The instance composes neither Better Auth nor Postgres.

Billing is not here and never comes here: the catalog, the routes, and Autumn
live in `apps/api/worker/billing/`, because they are hosted-only.

## What stays MIT

This library is AGPL, so the portable pieces live outside it. Merge rules and
wire framing are in `@epicenter/data/sync`, embedded-SQLite normalization is in
`@epicenter/sqlite`, and the subprotocol handshake vocabulary both halves must
agree on is in `@epicenter/sync`. None of those packages owns server schema or
authority lifecycle.
