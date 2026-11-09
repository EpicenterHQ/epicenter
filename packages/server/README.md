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
`c.var.audiences`: the guards, the folders mount, the protected resource
metadata, and the authorization server all read that one value. `apps/api`
passes `resolveOAuthAudiences`, which puts both on the deployment's own
origin: `api` at it and `folders` at `<origin>/folders`, the hosted cloud
included (ADR-0828).

Epicenter hosts no MCP server
([ADR-0578](../../docs/adr/0578-epicenter-hosts-no-mcp-server.md)):
agents on a machine use files and the `epicenter` CLI. This server is a
ledger, not a workplace (ADR-0835): it orders each folder's changes, keeps
every version, and admits people, and nothing is edited on it. A folder's
ledger is a log in Postgres, and its bytes over 16 KiB are in a blob store: R2
on the Worker, a directory on Bun (ADR-0824).

## The surfaces

Each `mount*` bundles its own auth wiring; the deployment passes only the auth
choice and any deployment policy.

| Mount | Source | Notes |
| --- | --- | --- |
| `mountFolders` | `src/routes/folders.ts`, `src/routes/folder.ts`, `src/routes/folders-api.ts` | Folders (ADR-0811, ADR-0824): each folder's log by its id (changes read and appended, files, history, marks, bytes, imports), making or joining a folder, every folder's head, and `/api/folders` for listing, sharing, accepting, and attaching to apps; the deployment supplies the blob store (`BlobStore`). |
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
server mints when it makes the folder, members who are people, and a
ledger, a log of changes that keeps every version (ADR-0824). Its title is the `title` of
its `epicenter.json`, which the server reads from the folder's files for
listings (`folderTitles`); the server keeps no name. The folders audience is
`<origin>/folders` on every deployment (`resolveOAuthAudiences`), and it is
also where the folders' routes are: `<folders>` below.

| Request | Needs |
| --- | --- |
| `POST <folders> { create, app?, import? }` or `{ join }` | `folders:write`: `create` makes a folder and never joins (`import` lets it take an import's changes until the import is done, ADR-0826); `join` joins the one folder attached to the app named (`409 choose` with `folders` when several, `404 none` when none). Answers `{ folder, made }` |
| `GET <folders>` | `folders:read`: `{ heads }`, the cursor of every folder the token reaches, one statement a program polls instead of one request per folder (ADR-0819) |
| `GET <folders>/<id>/changes?since=`, `POST …/files`, `GET …/log`, `GET …/marks`, `POST …/blobs`, `POST …/blobs/missing`, `GET …/blobs/<sha256>` | `folders:read`, the `read` role (`src/routes/folder.ts`) |
| `PUT …/blobs/<sha256>`, `POST …/changes`, `PUT …/marks/<name>`, `POST …/import` | `folders:write`, the `push` role |
| `GET /api/folders` | `folders:read` on the folders audience: `{ folders, pending }`, the folders the token reaches with their title, the caller's role, members, invitations by email (to members, not readers), and apps, and the invitations waiting for the caller |
| `GET /api/folders/<id>` | `folders:read`, the `read` role: one folder |
| `POST /api/folders/<id>/accept` | `folders:write`: accept the invitation waiting for the caller's verified email |
| `PUT /api/folders/<id>/members/<email> { role }` | `folders:write`, the `manage` role: invite an email, or change the role of someone who holds the folder; the same `{ person, role, pending }` whether or not anyone signs in with that email |
| `DELETE /api/folders/<id>/members/<email>` | `folders:write`: a member takes someone out or cancels an invitation; anyone leaves, or declines an invitation to their verified email |
| `PUT`/`DELETE /api/folders/<id>/apps/<app>` | `folders:write`, `folders:all`, the `push` role: attach the folder to an app, or detach it |

**Members.** A share is an invitation to an email (ADR-0820), a
`folder_invitation` row naming no account, so sharing answers the same
whether or not anyone signs in with the email, and an invitation is listed
by its email alone. It grants nothing and shows in the `pending` of the
account whose verified email it names, whether that account existed when it
was made or signed up later: nothing is copied at sign-up, since the match is
made when the invitation is read. Accepting makes a `folder_member` row, so
every member has accepted. Members are equal: a `member` changes files,
shares, unshares anyone, and changes roles; a `reader` syncs without
pushing and manages nothing (`src/folder-roles.ts`). No member owns a
folder. A folder lives while a member remains: the `folder_member_left`
trigger in `apps/api/drizzle` deletes it when its last member leaves (an
account's deletion included), with its invitations, attachments, and log.
The route that takes the last member out removes its bytes from the blob
store too.

**Reach.** A token with `folders:all` (the CLI and the Epicenter app)
reaches every folder its person holds. Any other token reaches the folders
attached to its app, `folder_app` rows naming the app by its OAuth client
id: an app's first sync attaches the folder it makes, and the person
attaches another through Epicenter, which no app can do for itself. A
desktop app's token holds only `ai` (ADR-0822), since on a computer only
Epicenter's programs sync.

### A folder's ledger

A folder's ledger is an append-only log in Postgres (`src/log/`,
migration `0011`):

| Table | Holds |
| --- | --- |
| `folder` | `seq`, its last change's number, which each change locks the row to take, so changes are numbered densely in the order they land; `epoch`, so a cursor `<epoch>.<seq>` from a log that was reset names nothing; and `importing` |
| `change` | `seq`, `at`, `account_id`, `author_text` (`Name <email>` as it was then), `via` (the OAuth client), `message` (an imported commit's), and `digest`, the SHA-256 of the previous digest and the change's canonical text, which today includes the account, author, and client (ADR-0829 decides a chain that covers what changed, not who) |
| `change_file` | each path a change wrote, its version (null for a deletion), and size; keyed `(folder, path, seq)`, indexed `(folder, seq)` |
| `file` | each path's version now, and its `folded` name (NFC, lower case), unique in the folder |
| `blob` | each SHA-256 the folder holds: its size, its bytes inline when they are at most 16 KiB, and whether it is `pending`, `kept`, or `purged` |
| `mark` | a name a person gave one change (ADR-0826) |

A file's version is the SHA-256 of its bytes, for every path. Appending a
change is one call of `epicenter_append_change`, so one round trip through
Hyperdrive. It
lands each path only where it still holds the version its writer expects;
otherwise nothing lands and it answers `409 moved` with every path that
moved and what it holds. A write either brings bytes of at most 16 KiB
(`text` or `base64`) or names a version the folder holds (`version`), so a
restore moves no bytes; a version it holds no bytes for is `409 missing`.
A name differing only in case from one the folder holds, a file where a
folder is, or a file below a file, is `409 refused` (the rules
`caseClash` held for Git trees). Writing what a path holds makes no change.

`changes?since=<cursor>` answers each path changed since the cursor with
its version now, in one statement, or `null` ("compare every path") for a
cursor of another epoch, past the head, or more than 50,000 changes or
2,000 paths behind (`CHANGES_GAP`, `CHANGES_LIMIT`); `files` then lists
every file. `files` answers the folder now or at a seq, a mark, or a time,
with inline bytes when asked; `log` answers changes oldest first after a
seq or newest first from a moment, and a file's history with `path`.

**Bytes.** Bytes over 16 KiB live in the deployment's `BlobStore` at
`folders/<id>/blobs/<sha256>` (`createR2BlobStore` over the Worker's bucket
binding, `createDiskBlobStore` on Bun), chosen by size, never by path. An
upload asks `blobs/missing` which versions the folder lacks, then `PUT`s
only those, checked against the hash; a row is `pending` until a change
names it. `sweepPendingBlobs` deletes, row and bytes, what stayed pending
past a day (`PENDING_FOR_MS`). `purgeBlobs` deletes kept bytes and keeps
every row naming them; by default it refuses a version a file holds now or
held within 90 days (`KEEP_MERGE_BASES_MS`), so a computer offline that
long still has the version it merges against. The deployment schedules
both; nothing thins history yet. ADR-0833 decides text inline up to 2 KiB and
each folder's older changes in its own archive; neither is built, and the
inline limit stays 16 KiB (`INLINE_MAX`).

**Git.** History leaves as Git through `epicenter export --git`, a
deterministic projection, and enters through `epicenter import --git`
(`packages/folder/src/git`, ADR-0826). No Git client reads from or writes to a
folder here: ADR-0834 decides that every folder is also a Git remote, where a
clone reads history and a push lands as a change, and ADR-0831 that
`epicenter git land` turns a branch into one change. Neither is built. Git's
writes carry neither a per-path expected version nor the merge by key, so they
arrive as a change that names each version it replaces. A folder made to import takes `POST …/import { changes }` until
`{ done: true }`; `{ abandon: true }` deletes it, its log, and its bytes,
only while it still imports (409 `not_importing` otherwise).

Who may reach a folder is the deployment's `FolderGuard`, passed to
`mountFolders` as `guard`: `authorize` decides one request (account, role,
folder, and the token's reach), and `join` makes or joins a folder. The
default, `databaseFolderGuard`, is `authorizeFolderRequest`; a test
without a database injects its own, and every rule after the decision is
the same code.

Refusals answer `{ error, error_description }`: 401 `invalid_token` with
`WWW-Authenticate` naming `resource_metadata`, 403 `insufficient_scope` or
`forbidden`, 404 `not_found`, 409 `choose` for a join among several
folders, 413 `too_large` for a body over the route's cap (16 MiB for a
change or an import), 502 `store_failed`, 503 `unavailable` when the
database could not decide. A folder that does not exist is refused like
one the caller does not hold, so a refusal says nothing of whether it
does. Folders take no billing policy.

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
| Guards | `src/middleware/require-auth.ts` | `requireAccessToken({ audience, scope })` in front of every resource, where `audience` names one of `c.var.audiences` (`api` or `folders`), and `requireSessionCookie()` in front of account management on the authorization server's own pages: this origin only, an `Origin` on every state change, and its own JSON 401 and 503 with no bearer challenge. |
| Account session | `src/auth/session-policy.ts` | `requireAccountSession`, the Better Auth hook that holds its account-management endpoints (`/link-social`, `/unlink-account`, `/delete-user`, and the passkey changes) to the same rules plus ten-minute freshness. `/delete-user` then refuses with `ACCOUNT_DELETION_UNAVAILABLE` (`src/auth/base-config.ts`). |

The provider runs unpatched ([ADR-0565](../../docs/adr/0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md)).
Its refresh family is every grant of one client for one person: a replay
after the 60-second reuse interval ends all of them, with every access token
they issued. The library stores a refresh's scopes, intersected with the
named resource's `allowedScopes`, on the new refresh token too, so both
audiences, `api` and `folders`, allow every scope and a refresh never narrows the
grant; each access token is still bound to its audience. Revoking
a refresh token ends only its latest rotation's access tokens, so a client
signing out revokes each access token it holds as well.

A resource that acts on a folder calls `authorizeFolderRequest` with its
own audience, the scope the operation needs, and the folder in its path,
then decides the operation from the role with the internal `roleAllows`
(`src/folder-roles.ts`); `mountFolders` does. The other mounted resources act on the account and sit
behind `requireAccessToken`, which runs `authorizeAccountRequest`. The
deployment names each mount's audience and scope:

| Mount | Audience | Scope |
| --- | --- | --- |
| `mountInferenceApp`, `mountTranscriptionApp` (`/v1/*`) | API | `ai` |
| `mountFolders` (a folder's routes) | Folders | `folders:read` to read, `folders:write` to write |
| `mountFolders` (`/api/folders`) | Folders | `folders:read` to list, `folders:write` to change; `folders:all` to attach |

A missing, unknown, revoked, or other-audience token answers 401 and a missing
scope 403, both with `WWW-Authenticate` naming the audience's
`resource_metadata`. `src/auth/oauth-server.postgres.test.ts` drives the real
mounts through both answers and a 200 on a disposable Postgres cluster, plus a
test-only route for the account check, and `authorizeFolderRequest`'s
answers directly.

## Folders as rows

`src/db/schema/folder.ts` holds the `folder`, `folder_member`,
`folder_invitation`, and `folder_app` tables, and the log's (above);
`src/folders.ts` makes, joins, lists, shares, accepts, and attaches folders
over them.
Migration `0009` carried each repository of the namespace model into a
folder of the same id, its namespace's members and grants into accepted
members, and a repository named for an app into that app's attachment, and
dropped namespaces. Migration `0010` moved each share still waiting into an
invitation to its person's email, made every `owner` and `writer` a
`member`, and left the trigger only deleting a folder with its last member.
Migration `0011` added the log, `0012` dropped the upload ledger its
`blob` table replaces, and `0013` renamed the append function `epicenter_append_change`. Folders held as Git repositories were not carried
over: hosted Git never ran, and a self-hosted server's repositories are
dropped (`apps/api/README.md`).

## Tests that need Postgres

The `*.postgres.test.ts` files start a private cluster with `initdb` and
`pg_ctl` under the OS temp directory (`TMPDIR`), apply every migration in
`apps/api/drizzle`, and stop the cluster afterward. They never connect to a
configured database. `src/test-helpers/oauth-checks.ts` holds the
authorization server checks that `apps/api` also runs against its Bun and
Worker entries.

A folder syncs with this server and no other (ADR-0803): the client keeps no
Git, and the server's ledger is the folder's history. The Yjs store sync
this package used to mount is removed (ADR-0534).
