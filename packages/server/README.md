# `@epicenter/server`

The AGPL Hono library `apps/api` composes on two runtimes: the Cloudflare
Worker (hosted Epicenter Cloud) and Bun with Postgres (`apps/api/server.ts`,
the self-host path). Both serve the OAuth 2.1 authorization server, and both
put every resource behind its access tokens (ADR-0549). A deployment builds the
parent app with `createServerApp`, guards each mount with `requireAccessToken`
for that mount's audience and scope, and mounts the surfaces it wants with the matching `mount*` primitive. `apps/api/worker/index.ts` is the
composition to read first.

`createServerApp` takes the deployment's identity: its origin
(`resolveOrigin`), the origins it trusts (`resolveTrustedOrigins`), and its
token audiences (`resolveAudiences`, from the resolved origin). The deployment
names its audiences once there (ADR-0326), and every request carries them as
`c.var.audiences`: the guards, the Git mount, the protected resource
metadata, and the authorization server all read that one value. `apps/api`
passes `resolveOAuthAudiences`, which puts the hosted cloud's Git audience on
its own host and any other deployment's under its origin.

Epicenter hosts no MCP server
([ADR-0578](../../docs/adr/0578-epicenter-hosts-no-mcp-server.md)):
agents on a machine use files, Git, and the `epicenter` CLI. It hosts no
blobs either: a recording's audio stays on the machine that made it
([ADR-0577](../../docs/adr/0577-audio-stays-on-the-machine-that-recorded-it.md)).

## The surfaces

Each `mount*` bundles its own auth wiring; the deployment passes only the auth
choice and any deployment policy.

| Mount | Source | Notes |
| --- | --- | --- |
| `mountGitHost` | `src/routes/git.ts` | Hosted Git at `<git audience>/<namespace>/<name>.git`: clone and fetch, the forward-only receiver, Git LFS, the web write translator, write-to-create, and `GET /api/repos`; the deployment supplies the stores (`GitHost`, `LfsStore`). |
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

### Hosted Git

`mountGitHost` serves a folder's remote, `<git audience>/<namespace>/<name>.git`
(ADR-0546, ADR-0547), over smart HTTP, and `GET /api/repos` on the API. The Git
audience is `https://git.epicenter.so` for the hosted cloud and `<origin>/git`
elsewhere (`resolveOAuthAudiences`).

| Request | Needs |
| --- | --- |
| `GET info/refs?service=git-upload-pack`, `POST git-upload-pack` | `folders:read`, the `read` role |
| `GET info/refs?service=git-receive-pack`, `POST git-receive-pack` | `folders:write`, the `push` role; a push that replaces `main`, the `rewrite` role (owner) |
| `POST info/lfs/objects/batch` | download: `folders:read`, `read`; upload: `folders:write`, `push` |
| `PUT`/`GET info/lfs/objects/<oid>`, `POST info/lfs/verify` | upload and verify: `push`; download: `read` |
| `GET epicenter/files?root=`, `GET epicenter/file?path=` | `folders:read`, the `read` role |
| `POST epicenter/writes` | `folders:write`, the `push` role |
| `GET /api/repos` | `folders:read` on the Git audience |

`<namespace>` may be `~`, the caller's personal namespace, so a web app reaches
`<account>/<app>` from its token alone (decision 46 of the file contract).

With a store that has `objects` (the disk store), every push goes to the
receiver (`src/routes/receive.ts`), never the store's own receive-pack. It
accepts `refs/heads/main` alone, decides fast-forward from the pushed commits,
accepts merge commits, and requires every changed file other than a `.md` note,
`.gitattributes` or `.gitignore` to be a Git LFS pointer whose object is stored,
whatever `.gitattributes` says (`src/git/lfs-rule.ts`). Only the owner may
replace `main`; the replaced commit is kept as `refs/epicenter/replaced/<time>`.
Web writes go to the translator (`src/routes/files.ts`): one commit per
request, notes merged with `@epicenter/definition/merge`'s `settle`, a losing
binary written beside its target as a conflict copy, and `captureId` receipts
kept under `refs/epicenter/captures/<id>`, moved with `main` in one transaction
and hidden from clients. Both use the `GitObjects` port (`src/git/objects.ts`):
refs, object reads, ancestry, and an atomic compare-and-swap `apply`.

One statement decides each Git request (`authorizeResourceRequest`): the access
token, given as a Bearer token or as the Basic password, its audience, scope,
and grant target; the namespace membership and role; and `<namespace>/<name>`
resolved through `repository`, then `repository_alias`. A repository that has
moved is checked against the namespace it lives in now. Nothing is cached.

A name nobody holds is not a repository until something is written to it.
Reading it creates nothing: a member whose role may push gets the empty
advertisement of a repository with no refs, for either service, so a sync that
fetches before it pushes finds nothing to take, and an empty file listing;
anyone else gets 404. Every writing request (a push, an LFS upload, a web
write) creates, at its start and after the same authorization:
the storage (`GitHost.create`) under a new id, then the row
(`createRepository`), so no row names a repository without storage. Two first
pushes at once insert one row, through the `(namespace_id, name)` unique key;
the one that loses writes into the winner's repository, and leaves an empty
store entry that no row names. Unrelated history pushed to an existing name
is refused, unless the owner forces it.

Refusals answer `{ error, error_description }`: 401 `invalid_token` with
`WWW-Authenticate` naming `resource_metadata` (and a Basic challenge for
terminal Git), 403 `insufficient_scope` or `forbidden`, 404 `not_found`,
413 `too_large` for a push over 64 MiB, 502 `store_failed`, 503
`git_unavailable` when the deployment has no store (or, for the files and LFS
routes, no `objects` or LFS store).
Hosted Git takes no billing policy.

`GitHost` is the replaceable part. It names a repository by its immutable id
(`repository.id`), never by `<namespace>/<name>`, and receives only requests
the route already authorized, never the client's credential:

```ts
type GitHost = {
  serve(id: string, request: GitRequest): Promise<Response>;
  create(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  /** The receiver's and translator's port; Artifacts gains it in phase 7. */
  objects?(id: string): GitObjects;
};
```

`GitRequest` is internal to `src/routes/git.ts`; an implementation receives it
through `GitHost['serve']` rather than importing it from the package.

The route resolves names to ids and lists from Postgres, so the store takes
an id where ADR-0546 sketches `(namespace, name)`, and has no `list`: a rename
or a move is a row update and an alias, with no storage call. `apps/api` binds
Cloudflare Artifacts (`worker/git-repositories.ts`); the Bun entry binds
`createDiskGitHost` from `@epicenter/server/bun` (`src/git-disk-store.ts`):
bare repositories at `<root>/<repository id>.git`, cloned and fetched through
`git http-backend` (receive-pack off, capture receipts hidden), written through
`index-pack` and one `update-ref --stdin` transaction, with no hook run, from
the repository or anywhere else, and a clean environment. Its LFS objects come
from `createDiskLfsStore` (`src/lfs/disk-lfs-store.ts`), at
`<root>/<repository id>/<aa>/<bb>/<oid>`, admitted only when their sha256
matches.

`renameRepository` and `moveRepository` (`src/repositories.ts`) are the
`manage` role's rename and move, each leaving an alias for the old
`<namespace>/<name>`. They are internal: the package does not export them, and
no route or screen mounts them yet.
A move also needs `push` in the destination.

## The authorization server

[ADR-0549](../../docs/adr/0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)
makes Epicenter one OAuth 2.1 authorization server. `oauthServerPlugins` in
`src/auth/plugins.ts` composes it, and `createAuth` adds it only when the
deployment passes `oauth` (through `createCloudContextMiddleware`'s
`oauthServer: true`, with the request's `c.var.audiences`). The provider seeds
its resources each time an instance initializes, and a Worker builds one per request, so only the context that
serves `/auth/*` composes it. Beside it are only passkeys: a Better Auth
session is the authorization server's own cookie, never a resource credential,
so there is no `bearer()`.

| Piece | Source | What it holds |
| --- | --- | --- |
| Policy | `src/auth/oauth-policy.ts` | Scopes, each audience's scope ceiling and the scopes its metadata lists, the 8-hour access and 30-day refresh lifetimes, the 60-second reuse interval, token prefixes, and the SHA-256 token hash. |
| Provider | `src/auth/plugins.ts` | `@better-auth/oauth-provider` with `disableJwtPlugin`, no dynamic registration and no client ID metadata documents (every client is a registered first-party row), `resourceSeedMode: "insertOnly"`, and the device grant. |
| Grant target | `src/auth/grant-target.ts` | `*` or `ns:<id>`, staged by the consent page through `POST /auth/grant-target/select` and listed by `GET /auth/grant-target/options`. It becomes the consent's `referenceId`, and a consent without one is refused. A device code is approved on the same consent page (`/auth/oauth2/authorize?user_code=<code>`), so its tokens carry the target natively. |
| Offline grants | `src/auth/offline-detach.ts` | Clears `sessionId` on a grant with a refresh token, so it outlives the browser session that approved it. |
| Registrations | `src/auth/oauth-registrations.ts` | `registerFirstPartyClients`, the one writer of the `oauth_client`, `oauth_resource`, and `oauth_client_resource` rows a deployment's first-party clients need: insert-only for resources, idempotent with no transaction, so concurrent writers converge. The Bun entry calls it at boot and the Worker once per isolate; no migration seeds a client. |
| Resource check | `src/auth/resource-access.ts` | `authorizeResourceRequest`: one SQL statement from a token, an audience, a scope, and a namespace to the account and its role, or a 401 or 403 with `resource_metadata`. `authorizeAccountRequest`: the same without a namespace, for resources that act on the account (inference, transcription, the repository listing). |
| Guards | `src/middleware/require-auth.ts` | `requireAccessToken({ audience, scope })` in front of every resource, where `audience` names one of `c.var.audiences` (`api` or `git`), and `requireSessionCookie()` in front of account management on the authorization server's own pages: this origin only, an `Origin` on every state change, and its own JSON 401 and 503 with no bearer challenge. |
| Account session | `src/auth/session-policy.ts` | `requireAccountSession`, the Better Auth hook that holds its account-management endpoints (`/link-social`, `/unlink-account`, `/delete-user`, and the passkey changes) to the same rules plus ten-minute freshness. `/delete-user` then refuses with `ACCOUNT_DELETION_UNAVAILABLE` (`src/auth/base-config.ts`). |

The provider runs unpatched ([ADR-0565](../../docs/adr/0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md)).
Its refresh family is every grant of one client for one person: a replay
after the 60-second reuse interval ends all of them, with every access token
they issued. The library stores a refresh's scopes, intersected with the
named resource's `allowedScopes`, on the new refresh token too, so both
audiences, `api` and `git`, allow every scope and a refresh never narrows the
grant; each access token is still bound to its audience. Revoking
a refresh token ends only its latest rotation's access tokens, so a client
signing out revokes each access token it holds as well.

A resource that acts on a namespace calls `authorizeResourceRequest` with its
own audience, the scope the operation needs, and the namespace in its path,
then decides the operation from the role with the internal `roleAllows`
(`src/namespace-roles.ts`); `mountGitHost` does (LFS is ADR-0544's). The other mounted resources act on the account and sit
behind `requireAccessToken`, which runs `authorizeAccountRequest`. The
deployment names each mount's audience and scope:

| Mount | Audience | Scope |
| --- | --- | --- |
| `mountInferenceApp`, `mountTranscriptionApp` (`/v1/*`) | API | `ai` |
| `mountGitHost` (Git requests) | Git | `folders:read` to fetch, `folders:write` to push |
| `mountGitHost` (`GET /api/repos`) | Git | `folders:read` |

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
`owner` and `member`; `NAMESPACE_ROLES`, internal to `src/namespace-roles.ts`,
says what each may do.

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
