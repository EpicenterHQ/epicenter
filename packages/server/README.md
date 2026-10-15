# `@epicenter/server`

The AGPL Hono library `apps/api` composes on two runtimes: the Cloudflare
Worker (hosted Epicenter Cloud) and Bun with Postgres (`apps/api/server.ts`,
the self-host path). Both serve the OAuth 2.1 authorization server, and both
put every resource behind its access tokens (ADR-0549). A deployment builds the
parent app with `createServerApp`, guards each mount with `requireAccessToken`
for that mount's audience and scope, and mounts the surfaces it wants with the matching `mount*` primitive. `apps/api/worker/index.ts` is the
composition to read first.

## The surfaces

Each `mount*` bundles its own auth wiring; the deployment passes only the auth
choice and any deployment policy.

| Mount | Source | Notes |
| --- | --- | --- |
| `mountSessionApp` | `src/routes/session.ts` | The profile read: the account an access token acts for. |
| `mountPersonalAuthorityBlobs` | `src/routes/authority-blobs.ts` | Personal owner URLs with private and public reads; deployment supplies local SQLite or S3 byte storage. |
| `mountGitApp` | `src/routes/git.ts` | Hosted Git: a connect route that mints a repository token, and the Git smart-HTTP data plane; deployment supplies the repository store. |
| `mountInferenceApp` | `src/routes/inference.ts` | Provider-backed inference. |
| `mountTranscriptionApp` | `src/routes/transcription.ts` | Provider-backed speech to text. |
| `mountAuthRoutes` | `src/routes/auth.ts` | Public auth shells (sign-in, consent, device approval), discovery metadata, and Better Auth's endpoints, including the authorization server. |

The hosted app builds `createCloudContextMiddleware` once, then combines it
with each mount's `requireAccessToken` guard using Hono's `every`. The context middleware
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
reads. Public reads need no token. Private reads require the deployment's read
guard and the URL's principal. Safe image, audio, and video types are served inline on public
URLs; other types are attachments. `DELETE` requires the write guard and the named
principal at either visibility. Deletion is idempotent and does not change rows.
These routes provide no listing or owner-wide erasure operation.

The URL parser and collection constructor live in `@epicenter/blobs` so the
Account-bound client validates publication responses against the same grammar.
The server parses request paths independently of the inbound Host header and
mints returned URLs on its configured public authority. The route owns range,
conditional, and media response policy; the store provides metadata and bytes.

### Hosted Git

`mountGitApp` serves a folder's Git repository over smart HTTP with a token
(ADR-0521). ADR-0546 replaces the connect route and its repository tokens with
`git.epicenter.so` access tokens; Todos' Connect still calls it, so it stays
until then. `POST /api/git/connect` takes `{ "folder": "<id>" }` behind the
deployment's guard, an access token for its Git audience with `folders:write`. The folder is a managed folder name: two or more
lowercase dot-separated labels, at most 64 bytes. The store finds or creates
the principal's repository for it and mints a write token for that repository
alone. The response is `{ remote, token, expiresAt }` with
`Cache-Control: no-store`, and `remote` is built on the configured public
origin, never the inbound Host.

The data plane is `GET /git/<name>.git/info/refs?service=git-upload-pack` (or
`git-receive-pack`, with no other query), `POST /git/<name>.git/git-upload-pack`,
and `POST /git/<name>.git/git-receive-pack`. Anything else under `/git/` is 404.
It sits outside `/api/`, so the cookie-CSRF guard never refuses a terminal
`git push`, and it checks no access token: the store's backend checks the token
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
serves `/auth/*` composes it. Beside it are only passkeys: a Better Auth
session is the authorization server's own cookie, never a resource credential,
so there is no `bearer()` and no session handoff.

| Piece | Source | What it holds |
| --- | --- | --- |
| Policy | `src/auth/oauth-policy.ts` | Scopes, each audience's scope ceiling, the 8-hour access and 30-day refresh lifetimes, the 60-second reuse interval, token prefixes, and the SHA-256 token hash. |
| Provider | `src/auth/plugins.ts` | `@better-auth/oauth-provider` with `disableJwtPlugin`, no dynamic registration, `resourceSeedMode: "insertOnly"`, the device grant, and `@better-auth/cimd`, whose plugin is kept per transport so its cache outlives a Worker request. |
| Grant target | `src/auth/grant-target.ts` | `*` or `ns:<id>`, staged by the consent or device approval page through `POST /auth/grant-target/select` and listed by `GET /auth/grant-target/options`. It becomes the consent's `referenceId`; a device approval without one is refused. |
| Offline grants | `src/auth/offline-detach.ts` | Clears `sessionId` on a grant with a refresh token, so it outlives the browser session that approved it. |
| Registrations | `src/auth/oauth-registrations.ts` | The `oauth_client` and `oauth_resource` rows a deployment's first-party clients need, written insert-only for resources. |
| Resource check | `src/auth/resource-access.ts` | `authorizeResourceRequest`: one SQL statement from a token, an audience, a scope, and a namespace to the account and its role, or a 401 or 403 with `resource_metadata`. `authorizeAccountRequest`: the same without a namespace, for resources that act on the account (inference, transcription, the profile read). |
| Guards | `src/middleware/require-auth.ts` | `requireAccessToken({ audience, scope })` in front of every resource, `requireSessionCookie()` in front of account management on the authorization server's own pages, and `requireBearerPrincipal` for the dev entry's resolver only. |
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

A resource that acts on a namespace calls `authorizeResourceRequest` with its
own audience, the scope the operation needs, and the namespace in its path,
then decides the operation from the role with `roleAllows`
(`src/namespace-roles.ts`); none is mounted yet (Git, LFS, and MCP are
ADR-0546's and ADR-0550's). The mounted resources act on the account and sit
behind `requireAccessToken`, which runs `authorizeAccountRequest`. The
deployment names each mount's audience and scope:

| Mount | Audience | Scope |
| --- | --- | --- |
| `mountInferenceApp`, `mountTranscriptionApp` (`/v1/*`) | API | `ai` |
| `mountSessionApp` (`/api/session`, the profile read) | API | `profile` |
| `mountGitApp` (`POST /api/git/connect`) | Git | `folders:write` |
| `mountPersonalAuthorityBlobs` | Git | `folders:read` to read a private object, `folders:write` to publish or delete |

A missing, unknown, revoked, or other-audience token answers 401 and a missing
scope 403, both with `WWW-Authenticate` naming the audience's
`resource_metadata`. `src/auth/oauth-server.postgres.test.ts` drives the real
mounts through both answers and a 200 on a disposable Postgres cluster, plus a
test-only route for the namespace check.

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
