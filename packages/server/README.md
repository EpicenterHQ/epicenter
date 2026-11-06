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
agents on a machine use files, Git, and the `epicenter` CLI. The only bytes
it keeps beside Git are a folder's Git LFS objects: in R2 on the
Worker, on disk on Bun
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

## The surfaces

Each `mount*` bundles its own auth wiring; the deployment passes only the auth
choice and any deployment policy.

| Mount | Source | Notes |
| --- | --- | --- |
| `mountGitHost` | `src/routes/git.ts`, `src/routes/folders-api.ts` | Folders (ADR-0811): a folder's sync routes by its id, its history as a Git remote at `<git audience>/folders/<id>.git` (clone and fetch, the forward-only receiver, Git LFS), the first sync that joins before it creates, where `main` is across a person's folders, and `/api/folders` for listing, sharing, accepting, and attaching to apps; the deployment supplies the stores (`GitHost`, `LfsStore`). |
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

### Folders

A folder (ADR-0811) is the one thing that is synced and shared: an id the
server mints at its first sync, members who are people, and a history that
is a Git repository storage names by that id. Its title is the `title` of
its `epicenter.json`, which the server reads from the folder's files for
listings (`folderTitle`); the server keeps no name. The Git audience is
`https://git.epicenter.so` for the hosted cloud and `<origin>/git`
elsewhere (`resolveOAuthAudiences`).

| Request | Needs |
| --- | --- |
| `POST <git>/folders { folder? }` | `folders:write`: a first sync. It joins the folder named when the caller holds it; from an app with none named, the one folder attached to the app the caller holds (`409 choose` with `folders` when several); otherwise it makes a folder, attached to the app that made it. Answers `{ folder, made }` |
| `GET <git>/folders` | `folders:read`: `{ heads }`, where `main` is in every folder the token reaches, one request a program polls instead of one per folder (ADR-0819) |
| `GET <git>/folders/<id>/changes?since=`, `POST …/tree`, `POST …/blobs`, `GET …/blobs/<id>` | `folders:read`, the `read` role (`src/routes/folder.ts`) |
| `PUT <git>/folders/<id>/blobs/<sha256>`, `POST …/commits` | `folders:write`, the `push` role |
| `GET info/refs?service=git-upload-pack`, `POST git-upload-pack` under `<git>/folders/<id>.git` | `folders:read`, the `read` role |
| `GET info/refs?service=git-receive-pack`, `POST git-receive-pack` | `folders:write`, the `push` role; a push that replaces `main`, the `rewrite` role (owner) |
| `POST info/lfs/objects/batch` | download: `folders:read`, `read`; upload: `folders:write`, `push` |
| `PUT`/`GET info/lfs/objects/<oid>`, `POST info/lfs/verify` | upload and verify: `push`; download: `read` |
| `GET /api/folders` | `folders:read` on the Git audience: `{ folders, pending }`, the folders the token reaches with their title, the caller's role, members, invitations (to owners), and apps, and the shares waiting for the caller |
| `GET /api/folders/<id>` | `folders:read`, the `read` role: one folder |
| `POST /api/folders/<id>/accept` | `folders:write`: accept the share waiting for the caller |
| `PUT /api/folders/<id>/members/<email> { role }` | `folders:write`, the `manage` role: share with a person, or change their role |
| `DELETE /api/folders/<id>/members/<email>` | `folders:write`: an owner takes someone out; anyone leaves, or declines a share |
| `PUT`/`DELETE /api/folders/<id>/apps/<app>` | `folders:write`, `folders:all`, the `push` role: attach the folder to an app, or detach it |

**Members.** A person is named by the email they sign in with. Sharing
makes a `folder_member` row whose `accepted_at` is null: it grants nothing,
shows only in that person's `pending`, and becomes membership when they
accept it. Any member may be an owner: roles are `owner`, `writer`, and
`reader` (`src/folder-roles.ts`), and an owner may change any member's,
except that the last owner may not step down while others hold the folder.
A folder lives while an accepted member remains: the `folder_member_left`
trigger in `apps/api/drizzle` deletes it when its last member leaves (an
account's deletion included), with its shares, attachments, and pending
uploads, and makes the earliest member an owner when its last owner leaves
others behind. The route that takes the last member out removes the
folder's repository storage too.

**Reach.** A token with `folders:all` (the CLI and the Epicenter app)
reaches every folder its person holds. Any other token reaches the folders
attached to its app, `folder_app` rows naming the app by its OAuth client
id: an app's first sync attaches the folder it makes, and the person
attaches another through Epicenter, which no app can do for itself.

With a store that has `objects` (the disk store), every push goes to the
receiver (`src/routes/receive.ts`), never the store's own receive-pack. It
accepts `refs/heads/main` alone, decides fast-forward from the pushed commits,
accepts merge commits, and requires every changed file other than a `.md` note
or a hidden path (any segment starting with `.`) to be a Git LFS pointer whose
object is stored, whatever `.gitattributes` says (`storedWithLfs` in
`@epicenter/definition/contract`). Only the owner may
replace `main`; the replaced commit is kept as `refs/epicenter/replaced/<time>`.
What a push may cost is the store's `ReceiveLimits` (`RECEIVE_LIMITS` on disk:
a 64 MiB body, 256 MiB of inflated objects held at once, and 100,000 of
`main`'s commits read, once per push, to place the push's stored commits); the
receiver keeps commits, trees and pointer-sized blobs, and lets larger blobs
go once hashed.
A folder's routes (below) read and commit over the same `GitObjects` port
(`src/git/objects.ts`): refs, object reads by kind, and an atomic
compare-and-swap `apply` over several refs (the receiver moves `main` and its
`replaced` backup together). They never merge (ADR-0773), and keep nothing
about a request once it answers.

### A folder's repository

Sync reaches a folder's repository by its id at `<git audience>/folders/<id>`
(`folderUrl` in `@epicenter/definition/site`), in Git's vocabulary
(ADR-0808; `src/routes/folder.ts`): `changes` since a commit, the `tree` at
a commit, `blobs` by id, and one `commits` request that lands every file
only where its path still holds the blob its writer expects, or answers
`409 moved` with what the path holds. An attachment's bytes are at
`blobs/<sha256>`: `GET` streams them with `Cache-Control: private,
immutable`, and `PUT` stores them, idempotent and checked against the hash,
for every Epicenter client; Git LFS's own protocol stays for plain Git.

An upload the repository did not already hold is pending in the
`blob_upload` ledger (`src/uploads.ts`) until a commit or a push that
references it keeps it; `sweepPendingUploads` deletes what is still pending
after a day, bytes and row. The deployment schedules the sweep. Presigned R2
uploads bypass the server and are not recorded. Purging what only history
holds is a person's, and is not built.

The receiver refuses a pointer in any layout but Git LFS's canonical one
(`readPointer`), since an attachment's version is that layout's blob id.

One statement decides each request on a folder (`authorizeFolderRequest`):
the access token, given as a Bearer token or as the Basic password, its
audience and scope; the caller's accepted membership and role; and the
token's reach. A folder that does not exist is refused like one the caller
does not hold, so a refusal says nothing of whether it does. Nothing is
cached. Nothing but a first sync makes a folder: a push to an id no one
holds is refused, and unrelated history pushed to a folder is refused unless
an owner forces it.

Refusals answer `{ error, error_description }`: 401 `invalid_token` with
`WWW-Authenticate` naming `resource_metadata` (and a Basic challenge for
terminal Git), 403 `insufficient_scope` or `forbidden`, 404 `not_found`,
409 `choose` for an app's first sync among several folders, 413 `too_large` for a push over the store's `pushBytes`, 502 `store_failed`, 503
`git_unavailable` when the deployment has no store (or, for the LFS routes, no
LFS store). Hosted Git takes no billing policy.

`GitHost` is the replaceable part. It names a repository by its folder's
id, and receives only requests the route already authorized, never the
client's credential:

```ts
type GitHost = {
  /** Clone and fetch (`git-upload-pack`); every push goes to the receiver. */
  serve(id: string, request: GitRequest): Promise<Response>;
  create(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  /** The receiver's and a folder's routes' port (`GitObjects`, `src/git/objects.ts`). */
  objects(id: string): GitObjects;
  /** What one push may cost this store; `RECEIVE_LIMITS` when absent. */
  receiveLimits?: ReceiveLimits;
};
```

`GitRequest` is internal to `src/routes/git.ts`; an implementation receives it
through `GitHost['serve']` rather than importing it from the package.

Who may reach a folder is the deployment's `GitAccess`, passed to
`mountGitHost` as `access`: `authorize` decides one request (account, role,
folder, and the token's reach), and `join` runs a first sync, joining or
making a folder. The default, `databaseGitAccess`, is the Postgres statement
above; a test without a database injects its own, and every rule after the
decision is the same code. The rows and listing live in Postgres, so the
store has no `list`. `apps/api` binds
Cloudflare Artifacts (`worker/git-repositories.ts`, whose `objects` are
`worker/artifacts-objects.ts`: refs from Artifacts' receive-pack
advertisement, objects through the binding by kind, and every ref move as one
`atomic` receive-pack), with LFS objects in R2 (`createR2LfsStore`,
`src/lfs/r2-lfs-store.ts`): clients upload and download through presigned
URLs that sign `content-length`, `if-none-match: *` and
`x-amz-checksum-sha256`, and an object is verified by one `head()` whose
sha256 checksum and size must match the pointer. The Bun entry binds
`createDiskGitHost` from `@epicenter/server/bun` (`src/git-disk-store.ts`):
bare repositories at `<root>/<folder id>.git`, cloned and fetched through
`git http-backend` (receive-pack off, every ref shown, in either protocol), written through
`index-pack` and one `update-ref --stdin` transaction, with no hook run, from
the repository or anywhere else, and a clean environment. Its LFS objects come
from `createDiskLfsStore` (`src/lfs/disk-lfs-store.ts`), at
`<root>/<folder id>/<aa>/<bb>/<oid>`, admitted only when their sha256
matches.

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
| Consent | `src/auth/plugins.ts` | An app that does not skip consent lands on the consent page, which also approves a device code (`/auth/oauth2/authorize?user_code=<code>`); the person's answer is the grant. Which folders a token reaches is its scopes, `folders:all` or not, and the apps folders are attached to (ADR-0811). |
| Offline grants | `src/auth/offline-detach.ts` | Clears `sessionId` on a native client's grant with a refresh token, so it outlives the browser session that approved it. A web client's grant stays bound, so signing out ends it. |
| Registrations | `src/auth/oauth-registrations.ts` | `registerFirstPartyClients`, the one writer of the `oauth_client`, `oauth_resource`, and `oauth_client_resource` rows a deployment's first-party clients need: insert-only for resources, idempotent with no transaction, so concurrent writers converge. The Bun entry calls it at boot and the Worker once per isolate; no migration seeds a client. |
| Resource check | `src/auth/resource-access.ts` | `authorizeFolderRequest`: one SQL statement from a token, an audience, a scope, and a folder to the account, its role, and the token's reach, or a 401 or 403 with `resource_metadata`. A token is admitted only when its audience is exactly the resource; one naming several is refused at each. `authorizeAccountRequest`: the same without a folder, for resources that act on the account (inference, transcription, the folder listing). |
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

A resource that acts on a folder calls `authorizeFolderRequest` with its
own audience, the scope the operation needs, and the folder in its path,
then decides the operation from the role with the internal `roleAllows`
(`src/folder-roles.ts`); `mountGitHost` does (LFS is ADR-0544's). The other mounted resources act on the account and sit
behind `requireAccessToken`, which runs `authorizeAccountRequest`. The
deployment names each mount's audience and scope:

| Mount | Audience | Scope |
| --- | --- | --- |
| `mountInferenceApp`, `mountTranscriptionApp` (`/v1/*`) | API | `ai` |
| `mountGitHost` (a folder's routes and remote) | Git | `folders:read` to read, `folders:write` to write |
| `mountGitHost` (`/api/folders`) | Git | `folders:read` to list, `folders:write` to change; `folders:all` to attach |

A missing, unknown, revoked, or other-audience token answers 401 and a missing
scope 403, both with `WWW-Authenticate` naming the audience's
`resource_metadata`. `src/auth/oauth-server.postgres.test.ts` drives the real
mounts through both answers and a 200 on a disposable Postgres cluster, plus a
test-only route for the account check, and `authorizeFolderRequest`'s
answers directly.

## Folders as rows

`src/db/schema/folder.ts` holds the `folder`, `folder_member`, `folder_app`,
and `blob_upload` tables; `src/folders.ts` makes, joins, lists, shares,
accepts, and attaches folders over them. Migration `0009` carried each
repository of the namespace model into a folder of the same id, its
namespace's members and grants into accepted members, and a repository
named for an app into that app's attachment, and dropped namespaces.

## Tests that need Postgres

The `*.postgres.test.ts` files start a private cluster with `initdb` and
`pg_ctl` under the OS temp directory (`TMPDIR`), apply every migration in
`apps/api/drizzle`, and stop the cluster afterward. They never connect to a
configured database. `src/test-helpers/oauth-checks.ts` holds the
authorization server checks that `apps/api` also runs against its Bun and
Worker entries.

Data folders sync over Git (ADR-0521); the Yjs store sync this package
used to mount is removed (ADR-0534).
