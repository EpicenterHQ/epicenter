# `@epicenter/server`

The AGPL Hono library `apps/api` composes on two runtimes: the Cloudflare
Worker (hosted Epicenter Cloud) and Bun with Postgres (`apps/api/server.ts`,
the self-host path). Both resolve Better Auth sessions to principals, and both
serve the OAuth 2.1 authorization server. A deployment builds the parent app
with `createServerApp`, supplies a bearer resolver, and mounts the surfaces it
wants with the matching `mount*` primitive. `apps/api/worker/index.ts` is the
composition to read first.

## The surfaces

Each `mount*` bundles its own auth wiring; the deployment passes only the auth
choice and any deployment policy.

| Mount | Source | Notes |
| --- | --- | --- |
| `mountSessionApp` | `src/routes/session.ts` | Reads the current principal back to a client. |
| `mountPersonalAuthorityBlobs` | `src/routes/authority-blobs.ts` | Personal owner URLs with private and public reads; deployment supplies local SQLite or S3 byte storage. |
| `mountGitApp` | `src/routes/git.ts` | Hosted Git: a connect route that mints a repository token, and the Git smart-HTTP data plane; deployment supplies the repository store. |
| `mountInferenceApp` | `src/routes/inference.ts` | Provider-backed inference. |
| `mountTranscriptionApp` | `src/routes/transcription.ts` | Provider-backed speech to text. |
| `mountAuthRoutes` | `src/routes/auth.ts` | Public auth shells (sign-in, consent, device approval), discovery metadata, and Better Auth's endpoints, including the authorization server. |

The hosted app builds `createCloudContextMiddleware` once, then combines it
with its session-bearer guard using Hono's `every`. The context middleware
acquires the database, constructs auth, and closes the handle after queued work
settles. Public HTML shells bypass it. The Bun entry does the same over a
`pg.Pool`.

Both entries pass their auth middleware to the same feature mounts. Each
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
(ADR-0521). ADR-0549 replaces the connect route and its repository tokens with
`git.epicenter.so` access tokens; Todos' Connect still calls it, so it stays
until Todos moves. `POST /api/git/connect` takes `{ "folder": "<id>" }` with the
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
deployment resolves no store. The Worker resolves Cloudflare Artifacts; the
Bun entry resolves none yet. Hosted Git takes no billing policy.

## The authorization server

[ADR-0549](../../docs/adr/0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)
makes Epicenter one OAuth 2.1 authorization server. `oauthServerPlugins` in
`src/auth/plugins.ts` composes it, and `createAuth` adds it only when the
deployment passes `oauth` (through `createCloudContextMiddleware`'s
`resolveOAuthServer`). The provider seeds its resources each time an instance
initializes, and a Worker builds one per request, so only the context that
serves `/auth/*` composes it. The session plugins (`bearer()`, the session
handoff, passkeys) stay beside it until every client signs in through it.

| Piece | Source | What it holds |
| --- | --- | --- |
| Policy | `src/auth/oauth-policy.ts` | Scopes, each audience's scope ceiling, the 8-hour access and 30-day refresh lifetimes, the 60-second reuse interval, token prefixes, and the SHA-256 token hash. |
| Provider | `src/auth/plugins.ts` | `@better-auth/oauth-provider` with `disableJwtPlugin`, no dynamic registration, `resourceSeedMode: "insertOnly"`, the device grant, and `@better-auth/cimd`, whose plugin is kept per transport so its cache outlives a Worker request. |
| Grant target | `src/auth/grant-target.ts` | `*` or `ns:<id>`, staged by the consent or device approval page through `POST /auth/grant-target/select` and listed by `GET /auth/grant-target/options`. It becomes the consent's `referenceId`; a device approval without one is refused. |
| Offline grants | `src/auth/offline-detach.ts` | Clears `sessionId` on a grant with a refresh token, so it outlives the browser session that approved it. |
| Registrations | `src/auth/oauth-registrations.ts` | The `oauth_client` and `oauth_resource` rows a deployment's first-party clients need, written insert-only for resources. |
| Resource check | `src/auth/resource-access.ts` | `authorizeResourceRequest`: one SQL statement from a token, an audience, a scope, and a namespace to the account and its role, or a 401 or 403 with `resource_metadata`. |
| CIMD transports | `src/auth/client-metadata-fetch.ts`, `@better-auth/cimd/node` | The Worker's `redirect: "manual"` fetch and the Bun host's resolve-once, address-pinned fetch. |

The refresh family is one grant's lineage, the refresh row's
`authorizationCodeId` (`device:<id>` for a device grant). A Bun patch of
`@better-auth/oauth-provider` 1.7.9, `patches/@better-auth%2Foauth-provider@1.7.9.patch`
in the root `package.json` `patchedDependencies`, makes reuse detection and
revocation key on it, and refuses a row without one. Revoking a live refresh
token ends its whole lineage, so the access tokens earlier rotations issued
stop too (RFC 7009). A refresh that names one audience narrows that access
token to the audience's scopes and leaves the refresh token's scopes whole,
so one grant serves several audiences (RFC 8707); unpatched, the first such
refresh narrowed the grant for good. It is written for upstream; re-verify it
on every Better Auth upgrade.

Every resource calls `authorizeResourceRequest` with its own audience, the
scope the operation needs, and the namespace in its path, then decides the
operation from the role with `roleAllows` (`src/namespace-roles.ts`). No
production route calls it yet; `src/auth/oauth-server.postgres.test.ts` mounts
a test-only route to exercise it.

## Namespaces

`src/db/schema/namespace.ts` holds ADR-0547's `namespace` and
`namespace_member` tables. The `user_personal_namespace` trigger in
`apps/api/drizzle` gives each account its personal namespace, with the account
as its only `owner`, inside the statement that inserts the account. Roles are
`owner` and `member`; `NAMESPACE_ROLES` says what each may do.

## Tests that need Postgres

The `*.postgres.test.ts` files start a private cluster with `initdb` and
`pg_ctl` under the OS temp directory (`TMPDIR`), apply every migration in
`apps/api/drizzle`, and stop the cluster afterward. They never connect to a
configured database. `src/test-helpers/oauth-checks.ts` holds the
authorization server checks that `apps/api` also runs against its Bun and
Worker entries.

## Shared protocol packages

These packages are private and AGPL-3.0-or-later. Worker bindings and
deployment composition remain in this package and its deployables. The Yjs
store sync this package used to mount is removed (ADR-0534); data folders sync
over Git (ADR-0521).
