# `@epicenter/server`

The AGPL Hono library both deployables compose: `apps/api` (hosted Epicenter
Cloud, many principals behind Better Auth) and `apps/self-host` (the
community-supported instance reference, with named sessions resolved to their
admitted users). A deployment builds the parent app with
`createServerApp`, supplies a bearer resolver, and mounts the surfaces it wants
with the matching `mount*` primitive. `apps/api/worker/index.ts` is the
composition to read first.

## The surfaces

Each `mount*` bundles its own auth wiring; the deployment passes only the auth
choice and any deployment policy.

| Mount | Source | Notes |
| --- | --- | --- |
| `mountSessionApp` | `src/routes/session.ts` | Reads the current principal back to a client. |
| `mountPersonalAuthorityBlobs` | `src/routes/authority-blobs.ts` | Personal owner URLs with private and public reads; deployment supplies local SQLite or S3 byte storage. |
| `mountGitApp` | `src/routes/git.ts` | Hosted Git: a connect route that mints a repository token, and the Git smart-HTTP data plane; deployment supplies the repository store. |
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

### Personal hosted blobs

Both deployments mount `POST /api/blobs/personal/{principalId}/{private|public}`.
The body is limited to 25 MiB. A successful create-only write returns
`{ "url": "https://.../api/blobs/personal/{principalId}/{visibility}/{key}" }`.
The authority allocates the key; callers cannot choose or replace one. An
uncertain storage response returns 503 without exposing the allocated URL.

`GET` and `HEAD` at that exact URL support single byte ranges and conditional
reads. Public reads need no session. Private reads require a live bearer for the
URL's principal. Safe image, audio, and video types are served inline on public
URLs; other types are attachments. `DELETE` requires a live bearer for the named
principal at either visibility. Deletion is idempotent and does not change rows.
These routes provide no listing or owner-wide erasure operation.

The URL parser and collection constructor live in `@epicenter/blobs` so the
Account-bound client validates publication responses against the same grammar.
The server parses request paths independently of the inbound Host header and
mints returned URLs on its configured public authority. The route owns range,
conditional, and media response policy; the store provides metadata and bytes.

### Hosted Git

`mountGitApp` serves a folder's Git repository over smart HTTP with a token
(ADR-0521). `POST /api/git/connect` takes `{ "folder": "<id>" }` with the
deployment's session auth. The folder is a managed folder name: two or more
lowercase dot-separated labels, at most 64 bytes. The store finds or creates
the principal's repository for it and mints a write token for that repository
alone. The response is `{ remote, token, expiresAt }` with
`Cache-Control: no-store`, and `remote` is built on the configured public
origin, never the inbound Host.

The data plane is `GET /git/<name>.git/info/refs?service=git-upload-pack` (or
`git-receive-pack`, with no other query), `POST /git/<name>.git/git-upload-pack`,
and `POST /git/<name>.git/git-receive-pack`. Anything else under `/git/` is 404.
It sits outside `/api/`, so the cookie-CSRF guard never refuses a terminal
`git push`, and it does no session auth: the store's backend checks the token
in `Authorization`. A request without one gets 401 before the store runs. The
module forwards only `Authorization`, `Content-Type`, `Content-Encoding`,
`Accept`, and `Git-Protocol`, streams both bodies, drops upstream `Set-Cookie`,
and removes `WWW-Authenticate` when the request carried an `Origin`, so a
browser sees a readable 401 instead of a login prompt. The global CORS
middleware decorates every response and answers preflights without a token.

Failures answer `{ name, message }`: 400 `InvalidFolder`, 401 `MissingToken`,
502 `GitStoreFailed` when the store throws, and 503 `GitUnavailable` when the
deployment resolves no store. `apps/api` resolves Cloudflare Artifacts;
`apps/self-host` resolves none yet. Hosted Git takes no billing policy.

## Shared protocol packages

These packages are private and AGPL-3.0-or-later. Worker bindings and
deployment composition remain in this package and its deployables. The Yjs
store sync this package used to mount is removed (ADR-0534); data folders sync
over Git (ADR-0521).
