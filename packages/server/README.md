# `@epicenter/server`

The AGPL Hono library both deployables compose: `apps/api` (hosted Epicenter
Cloud, many principals behind Better Auth) and `apps/self-host` (the
community-supported instance reference, with named sessions resolved to their
admitted users). A deployment builds the parent app with
`createServerApp`, supplies a bearer resolver, and mounts the surfaces it wants
with the matching `mount*` primitive. `apps/api/worker/index.ts` is the
composition to read first.

## The store authority

A stable library has one Durable Object authority. Personal addresses include
application, authenticated actor, and data ID; Shared addresses include
application and data ID and are enabled only by the self-hosted Worker.
The generation is stored inside that authority, not in its object name.

`mountStoreSyncApp` owns authentication and destination validation:

- `POST /api/libraries/:appId/:library/data/:dataId/current` atomically
  initializes an absent library and returns its complete current capture.
- `GET /api/store/v1/sync` upgrades with `appId`, `library`, `dataId`,
  `generation`, and an optional `cursor` in the query. The authority admits
  that generation before accepting edits.

The download is framed by `@epicenter/sync/current-download`. Decode it with
`readCurrentDownload`: its snapshot and ordered update tail cover the returned
head. Treating the response body as one document update loses this contract.
The browser validates and installs the complete capture before making its cache
usable. A usable cache can reopen offline.

`StoreAuthority` adapts Worker storage and sockets to
`openCurrentAuthority` in `@epicenter/app/sync`. That authority owns atomic
initialization, generation admission, replacement, and activation retry receipts.
It holds opaque bytes; the browser owns document validation. A socket upgrade
is not admission: an unavailable generation receives a retirement frame and
closes without joining the live hub.

Personal startup checks the historical `GenerationsLedger` only to refuse
implicit migration. Historical listing, import, initial-selection, and
snapshot endpoints are not mounted. Existing history remains untouched.

Browser socket credentials use the bearer subprotocol; the response echoes
only the main protocol. The authenticated principal selects the Personal
owner. Caller-supplied owner overrides are refused.

## The other surfaces

Each `mount*` bundles its own auth wiring; the deployment passes only the auth
choice and any deployment policy.

| Mount | Source | Notes |
| --- | --- | --- |
| `mountSessionApp` | `src/routes/session.ts` | Reads the current principal back to a client. |
| `mountBlobsApp` | `src/routes/blobs.ts` | Opaque owner-pinned blob objects, S3-compatible behind `resolveDeploymentBlobStore`. |
| `mountInferenceApp` | `src/routes/inference.ts` | Provider-backed inference, with `rateLimit` available as a policy. |
| `mountTranscriptionApp` | `src/routes/transcription.ts` | Provider-backed speech to text. |
| `mountAuthRoutes` | `src/routes/auth.ts` | Public auth shells and database-backed auth endpoints. Cloud only. |

The hosted app builds `createCloudContextMiddleware` once, then combines it
with its session-bearer guard using Hono's `every`. The context middleware
acquires the database, constructs auth, and closes the handle after queued work
settles. Public HTML shells bypass it. Self-host supplies its named-session
resolver and composes neither the hosted Better Auth context nor Postgres.

Both deployments pass their auth middleware to the same feature mounts. Each
mount registers exact methods and paths with Hono, keeping auth, validation,
and handlers together. Unknown paths and unsupported methods do not run those
route dependencies. Billing keeps a sub-app for its local error handler.

Billing is not here and never comes here: the catalog, the routes, and Autumn
live in `apps/api/worker/billing/`, because they are hosted-only.

## Shared protocol packages

These packages are private and AGPL-3.0-or-later. Merge rules and
wire framing are in `@epicenter/app/sync`, embedded-SQLite normalization is in
`@epicenter/sqlite`, and the routes, HTTP capture framing, and subprotocol vocabulary both halves
use are in `@epicenter/sync`. Worker bindings and deployment composition remain
in this package and its deployables.
