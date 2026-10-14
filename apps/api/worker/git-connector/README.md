# GitHub Git connector

The hosted connector lets a signed-in Epicenter principal sync a folder with
a private GitHub repository without any client holding a GitHub credential.
The person authorizes the GitHub App separately from Epicenter sign-in and
lists the private repositories the app can reach for them. GitHub tokens stay
sealed in that principal's Durable Object.

A folder reaches its repository in one of two ways, which differ only in how
the connector admits a Git request:

- A folder that owns its remote holds the canonical clone URL
  `https://github.com/<owner>/<name>.git` in `.git/config`. The page's Git
  transport rewrites requests for that URL to the connector's repository
  routes. No pairing is stored.
- An installed app's hosted dataset pairs a folder with a repository by id.
  The client keeps the folder contract's `remote: { url, branch }` and
  `httpFetch`
  ([ADR-0509](../../../../docs/adr/0509-folder-remotes-and-http-fetch-have-separate-contracts.md)).
  `remote.url` is the clone URL recorded at pairing. `httpFetch` routes Git
  requests to this connector, addressed to the pairing revision, with the
  Epicenter session bearer.

Status: deployed at `api.epicenter.so` on October 8 from source commit
`17724f7fd6`, Worker version `fa1829a1-b36a-4c13-a741-45c0016ba0f4`. The Worker
build and focused tests pass. Live checks confirm unauthenticated pairing
requests receive 401, invalid callbacks receive 400, and sign-in serves 200.
GitHub authorization and transfers remain unverified. Todos now has a browser
caller in source; the deployed Worker does not yet allow its `/sync` callback.
The
journey fixture under `work/zhongwen-github-connector-20261007/` targets the
earlier fixed-repository prototype; it no longer compiles against this code
and does not describe the current flow.

The repository integration is registered as
[Epicenter Folder Sync](https://github.com/apps/epicenter-folder-sync), owned by
EpicenterHQ and installable by any account. Its App ID is `5223530` and client
ID is `Iv23liVOZq7MxkQXPluj`. It requests Contents write and mandatory Metadata
read. User access tokens expire after eight hours. Connector deployment secrets
are configured. Registration and deployment do not prove authorization or
transfer: selected-repository installation and live GitHub acceptance remain
outstanding.

## Identity

Every route except the GitHub callback runs behind the host's `auth`
middleware, which must verify the Epicenter session and set
`c.var.principal`. In the hosted API that is
`requireBearerPrincipal(resolveRequestSessionPrincipal)` after the cloud
context middleware. The connector reads no identity from headers, query, or
body.

`Origin` gates nothing. The session bearer is not ambient, so a request
without the bearer gets the session middleware's 401 from any origin, and a
request with it works from any origin, including the loopback origin
(`http://127.0.0.1:<port>`) a native broker forwards. CORS decides only which
browser pages may read responses.

The Epicenter session middleware alone answers HTTP 401. Connector failures,
including a missing or revoked GitHub grant, are 403 or another status with
a code. An Epicenter `Account` treats 401 as its own session failing, so a
GitHub problem must never look like one.

## State

One `GitHubConnection` Durable Object per principal, named
`principal:<principalId>`. It holds three independent parts:

| Key | Holds | Lifetime |
| --- | --- | --- |
| `txn:<id>` | Pending authorization: hashed provider state, PKCE verifier, browser state and challenge. After the callback: a one-use handoff with the sealed grant. | 10 minutes pending, 5 minutes handoff; at most 5 per principal |
| `grant` | GitHub user id and login, sealed access and refresh tokens, expiry | Until the refresh token expires, GitHub rejects it, or a refresh names another GitHub user |
| `pairing:<folderId>` | Revision, repository id, installation id, owner id, branch, the GitHub user that paired it, and the name and clone URL at pairing time | Until unpaired or replaced. Survives grant expiry and revocation. |

The object also records the principal that first wrote it and refuses calls
naming another. Every operation runs through one in-object queue, so
concurrent requests from any Worker isolate share one token refresh.

Tokens are sealed with AES-GCM under `GIT_GRANT_ENCRYPTION_KEY`, with the object id as
additional data. Secrets in state and handoff codes are stored as SHA-256
hashes. An alarm fires at the next transaction or grant expiry and deletes
what has expired; pairings are never swept.

## Protocol

All paths are under `/api/git/github` on the API origin. Requests and
responses are JSON unless noted. Responses carry `Cache-Control: no-store`.

### 1. Start GitHub authorization

```
POST /connect
Authorization: Bearer <Epicenter session>

{ "redirectUri": "https://zhongwen.bradenwong.com/sync",
  "state": "<43 base64url>", "codeChallenge": "<BASE64URL(SHA-256(verifier))>" }
```

`redirectUri` must exactly match an allow-listed web callback. The response is
`{ "authorizeUrl": "https://github.com/login/oauth/authorize?..." }`, which
the page navigates to. The connector sends GitHub its own state and PKCE S256
challenge; the client's never reach GitHub.

Initial GitHub consent is web-only: there is no native or loopback callback,
and none is planned. The grant belongs to the principal, so any other app
signed in as the same principal, including a native one through its broker,
uses it without consenting again.

### 2. GitHub callback

GitHub returns to `GET /callback?code&state`. This route is unauthenticated.
The state is `<object id>.<transaction id>.<secret>`: the object id routes to
the initiating principal's object, which consumes the transaction before any
network call. A replayed or forged state gets a 400 text page and no
redirect. The connector exchanges the code with its PKCE verifier, reads
`/user`, and redirects to the exact callback:

```
https://zhongwen.bradenwong.com/sync?github_code=<handoff code>&github_state=<browser state>
https://zhongwen.bradenwong.com/sync?github_error=<code>&github_state=<browser state>
```

No token appears in a URL.

### 3. Complete

```
POST /complete
Authorization: Bearer <Epicenter session>

{ "code": "<github_code>", "verifier": "<browser PKCE verifier>", "redirectUri": "https://zhongwen.bradenwong.com/sync" }
```

The request is routed by the verified principal. A code begun by another
principal names a transaction this principal's object does not hold, so it
fails with `invalid_grant` without touching the initiator's handoff. A wrong
verifier or callback burns the handoff. Success installs the grant and
returns `{ "user": { "id": 101, "login": "alice" } }`.

Each completion replaces the stored grant. If two independent authorizations
are in flight, the grant left is the one whose completion succeeded last,
not the one that started last.

Installing a grant for a different GitHub user leaves pairings in place but
unusable (see Pairings).

### 4. Discover repositories

`GET /repositories` returns `{ "repositories": [...] }`: every private
repository the granted user can reach through this app's installations, from
`GET /user/installations` and `GET /user/installations/{id}/repositories`.
Each entry has `id`, `installationId`, `ownerId`, `fullName`, `cloneUrl`,
`defaultBranch`, and `push`. Discovery makes REST reads only, no Git request
and no scoped token. The listing shows what the person can reach through an
installation; it is never evidence of what a scoped token can reach.

### 5. Pair a folder

```
PUT /pairings/<folderId>
{ "repositoryId": 9001, "installationId": 7001, "branch": "main", "replace": false }
```

`folderId` is 1 to 128 characters: an initial `[A-Za-z0-9_-]`, followed by
`[A-Za-z0-9._-]`. This includes application IDs such as
`com.bradenwong.zhongwen`. `branch` is optional and defaults
to the repository's default branch. Pairing:

1. confirms the grant with `/user`, refreshing first when due or rejected;
2. requires `installationId` among the user's installations, and takes its
   account id as the owner;
3. mints a token scoped to `repositoryId` under that owner (see Transfers);
4. reads `GET /repositories/{repositoryId}` with the scoped token and
   requires that id, owned by that account, private, with pull and push;
5. stores the pairing with a new random 22-character `revision`.

A forged, public, read-only, or unreachable selection is
`repository_unavailable` (403) with `installUrl` when the app slug is set.

An existing pairing for the same repository, installation, branch, and
GitHub user is returned unchanged, revision and recorded name and URL
included. Any other change is `pairing_conflict` (409) unless
`replace: true`. A replacement, even of the same choice, and a pairing made
after `DELETE`, get a new revision. The connector never rewrites a folder's
origin or revision on its own.

`GET /pairings` lists
`{ folderId, revision, status, repository: { id, installationId, fullName }, remote: { url, branch } }`.
`status` compares the stored grant with the pairing: `ready` when the stored
grant belongs to the GitHub user that paired the folder,
`github_account_mismatch` when it belongs to another, and
`github_authorization_required` when there is none. It makes no network call,
so `ready` does not mean GitHub still honors the grant; the next transfer's
consent check decides that. `DELETE /pairings/<folderId>` removes one.

Reconnecting the same GitHub user makes existing pairings `ready` again at
their existing revisions. A different GitHub user cannot use them until each
folder is re-paired with `replace: true`, which verifies the new user's
access and mints a new revision.

### 6. Git transfers

Git requests arrive on two route families: pairing routes, addressed to a
folder and its pairing revision, and repository routes, addressed to a
repository by owner and name. Both mint a token scoped to one repository id
and send the request to the clone URL GitHub reports for that id. Every relay
rule after admission is shared.

#### Pairing routes

The client's `httpFetch` rewrites the pairing's `remote.url` prefix to
`<api>/api/git/github/git/<folderId>/<revision>` and adds the Epicenter
bearer:

| Method | Path |
| --- | --- |
| GET | `/git/<folderId>/<revision>/info/refs?service=git-upload-pack` |
| GET | `/git/<folderId>/<revision>/info/refs?service=git-receive-pack` |
| POST | `/git/<folderId>/<revision>/git-upload-pack` |
| POST | `/git/<folderId>/<revision>/git-receive-pack` |

Each request is admitted once. The principal's object:

1. loads the pairing, or answers `pairing_not_found` (404);
2. refuses any revision but the current one with `pairing_superseded` (409),
   before any GitHub call. A transport configured for a replaced pairing,
   whether the repository, branch, installation, or GitHub user changed,
   cannot reach the new destination or mint a token;
3. confirms the grant with `GET /user` every time, so a person who revoked
   the app is refused even while the stored token has not expired. A due
   token is refreshed first, and a token `/user` rejects is refreshed once;
4. refuses with `github_account_mismatch` if the grant's GitHub user did not
   make the pairing;
5. requires the paired `installationId` among the user's installations,
   read with the parent token, with the paired owner as its account;
6. calls `POST /applications/{client_id}/token/scoped` with client id and
   secret as Basic auth and
   `{ access_token, target_id: ownerId, repository_ids: [repositoryId], permissions: { contents: "write" } }`;
7. reads `GET /repositories/{repositoryId}` with the scoped token and
   requires the paired id and owner, private, with pull and push. A denied
   read, or a body naming another id or owner, is `repository_unavailable`;
8. returns the scoped token and the clone URL GitHub reported for that id.

#### Repository routes

A folder whose `.git/config` names the canonical clone URL
`https://github.com/<owner>/<name>.git` needs no pairing. Its page's Git
transport rewrites that URL's prefix to
`<api>/api/git/github/repos/<owner>/<name>.git` and adds the Epicenter bearer:

| Method | Path |
| --- | --- |
| GET | `/repos/<owner>/<name>.git/info/refs?service=git-upload-pack` |
| GET | `/repos/<owner>/<name>.git/info/refs?service=git-receive-pack` |
| POST | `/repos/<owner>/<name>.git/git-upload-pack` |
| POST | `/repos/<owner>/<name>.git/git-receive-pack` |

`<owner>` must be a GitHub login: alphanumerics and single inner hyphens, at
most 39 characters. `<name>` must be 1 to 100 characters of
`[A-Za-z0-9._-]`, neither `.` nor `..`, followed by a required `.git`. Any
other shape is `invalid_request` (400) before any GitHub call. The
principal's object:

1. confirms the grant with `GET /user`, as for a pairing route;
2. reads `GET /repos/{owner}/{name}` with the parent token to learn the
   repository id and owner id. A denied or missing repository is
   `repository_unavailable`; a 401 means the grant was revoked after `/user`
   confirmed it, and deletes the grant;
3. requires an installation whose account is that owner among the user's
   installations, or answers `repository_unavailable`;
4. scopes a token to that repository id under that owner and reads it by id,
   exactly as steps 6 to 8 above.

The name only locates the repository. The scoped token and the read by id
decide what is reached, so a repository deleted and replaced at that name
between the two reads gets no scoped token. GitHub answers a renamed
repository's old name with a redirect, which the connector does not follow;
such a request is `upstream_unavailable` until the folder's remote names the
new path.

#### Relay

The installation listing is not used to judge the scoped token: GitHub lists
every repository in the installation even for a token scoped to one. The read
by id and Git itself are the token's actual access. The connector does not
probe unrelated repositories to prove the narrowing on each transfer.

The edge sends one Git request to `https://github.com/<owner>/<name>.git`,
with the scoped token as Basic auth. The parent user token is used only for
REST reads and scoping, never for Git, and never leaves the object. Because
the path comes from the repository id after narrowing, a repository deleted
and replaced at the same name cannot get a scoped token, and a renamed
repository is reached at its new path.

A request admitted before its pairing is replaced finishes against the
repository it was admitted for; the next request for the old revision is
refused. A fetch or push spans several requests, so one that straddles a
replacement fails partway with `pairing_superseded`.

Scoping failures:

| GitHub answer | Result |
| --- | --- |
| 200 with a token that is not the parent and reads the repository by id | used for this request |
| 404 (documented for an invalid parent token) | the grant was revoked after `/user` confirmed it: grant deleted, `github_authorization_required` |
| 422, or 403 without rate limiting | `repository_unavailable` |
| 401 | `not_configured`: GitHub rejected the client credentials |
| 429, rate-limited 403, 5xx, network failure | `upstream_unavailable`; the grant is kept |
| any other status, a 200 without a token, or the parent echoed | `credential_scoping_unsupported` (503) |

There is no fallback to the parent token.

GitHub's answer to the Git request is reported, not retried. A 401 means
GitHub refused the freshly scoped token for that request:
`scoped_token_rejected` (403). The connector does not refresh the grant or
replay the request; the client's next request is admitted afresh with a new
scoped token. A POST whose outcome is unknown (the connection failed after
sending) is `upstream_unavailable`, and the client must not assume the push
failed.

Requests may carry only `Authorization`, `Content-Type`, `Content-Encoding`,
`Git-Protocol`, and `Accept`. A POST must use `application/x-<service>-request`
and may declare `Content-Encoding` `identity` or `gzip` (any case); any other
coding is `invalid_request`. A gzip body and its header pass through to
GitHub unchanged; the connector never decodes it, so the 64 MiB limit counts
compressed bytes. Upstream gets only `Accept`, `Content-Type`,
`Content-Encoding` (gzip only), `Git-Protocol`, a fixed `User-Agent`, and
Basic auth. Redirects are refused, never followed. Only `Content-Type` comes
back. Bodies stream through the limit both ways, and client cancellation
aborts the upstream request.

A rejected branch update inside a 200 `git-receive-pack` passes through
untouched.

### Token refresh ordering

GitHub rotates refresh tokens. The object writes the new pair before
checking it, so a transient failure cannot strand the grant. It uses the new
token only after `/user` returns the same GitHub user id; if that check
cannot run, the operation fails with `upstream_unavailable` and the next
operation checks the stored pair before using it. A rejected refresh token, a
different GitHub user, or a grant that fails to unseal deletes the grant and
keeps every pairing.

### Errors

Every connector error is JSON `{ "error": code, "message": string }`, plus
`installUrl` when known, with the code in `X-Epicenter-Git-Error`.

| Code | Status | Meaning |
| --- | --- | --- |
| `github_authorization_required` | 403 | No live GitHub grant: never connected, expired, revoked, or refreshed into another user. Authorize GitHub again. |
| `github_account_mismatch` | 403 | The pairing was made by another GitHub user. Re-pair with `replace`. |
| `repository_unavailable` | 403 | The app and user cannot reach this private repository with write access by id. |
| `scoped_token_rejected` | 403 | GitHub's Git endpoint refused the scoped token for this request. |
| `repository_mismatch` | 403 | GitHub redirected a Git request, or reported a clone URL off `github.com`. |
| `principal_mismatch` | 403 | A call reached another principal's object. A routing bug. |
| `access_denied` | redirect | The person declined on GitHub. |
| `pairing_not_found` | 404 | The folder has no pairing. |
| `pairing_conflict` | 409 | The folder is paired differently; pass `replace`. |
| `pairing_superseded` | 409 | The request names a revision that has been replaced. |
| `authorization_failed` | 400 or redirect | GitHub rejected the code exchange. |
| `invalid_grant` | 400 | Handoff code invalid, expired, used, or another principal's. |
| `invalid_request` | 400 | Malformed parameters, headers, encoding, or body. |
| `payload_too_large` | 413 | Body over the limit. |
| `upstream_rejected` | 502 | Unexpected Git status or content type. |
| `credential_scoping_unsupported` | 503 | GitHub did not return a scoped token distinct from the parent. |
| `upstream_unavailable` | 503 | GitHub unreachable, rate limited, or 5xx. Nothing is known about the grant. |
| `not_configured` | 503 | Bindings missing or malformed, or GitHub rejected the client credentials. |

### CORS

Every route except `/callback` allows exactly the origins of the allow-listed
callbacks; methods `GET`, `POST`, `PUT`, `DELETE`; request headers
`Authorization`, `Content-Type`, `Content-Encoding`, `Git-Protocol`; and
exposes `X-Epicenter-Git-Error`. It never sends
`Access-Control-Allow-Credentials`. Preflights need no session.

## External assumptions

The coordinating session checked the official REST reference for
`POST /applications/{client_id}/token/scoped`: client id and secret as Basic
auth; a body of `access_token`, a target (`target_id`), repositories
(`repository_ids`), and `permissions`; a 200 carrying `token`; and 404 for an
invalid parent token.

A live probe on October 8 with the registered app established:
user authorization succeeded and scoping returned a distinct token.
`GET /user/installations/{id}/repositories` with that scoped token still
listed both private repositories in the installation. Git `info/refs` with
the same scoped token as `x-access-token` Basic auth answered 200 for the
scoped repository and 403 for the other private repository. The listing is
therefore discovery only; the connector judges a scoped token by the read by
id. GitHub enforces the repository restriction requested by the scoped-token
endpoint; metadata listing is not an independent proof of exclusion.
Live pairing through `GET /repositories/{id}` succeeded, including identity,
privacy, and explicit pull/push checks. Browser Download fetched the existing
private history at `1bddce6`. Discovery also returned the required installation
and repository fields.

Still unproved against GitHub:

| Unproved | Why it matters |
| --- | --- |
| A scoped token's metadata read of another private repository is denied. Only Git advertisement denial was probed live. | Scope enforcement evidence; production does not probe unrelated repositories |
| Limits on how many scoped tokens a user and app may hold, and whether minting past a limit revokes the earliest token, including the parent. The connector mints one per Git request, so check that the parent still works after at least 20 scopes. | A limit that revokes the parent would end the grant after a few requests |
| Refresh-token rotation, and that scoped tokens minted from an old parent stop or keep working after a refresh. | Refresh ordering and in-flight transfers |
| Revoking the app makes `/user` return 401. | The consent check |
| [Git v2.50.1 remote-curl source](https://github.com/git/git/blob/v2.50.1/remote-curl.c) compresses buffered RPC bodies larger than 1 KiB when gzip is enabled. The coordinator verified this source. | Accepting `Content-Encoding: gzip` |
| A local workerd probe preserves the gzip header, byte count, and SHA-256 through the connector (`work/zhongwen-github-connector-20261007/gzip-worker-result.json`). Cloudflare’s deployed edge and real GitHub forwarding remain unverified. | gzip pass-through |

The tests in this directory run against a simulated provider in
`test-support.ts` that encodes these assumptions. Passing tests show the
connector follows them. They do not show GitHub does.

## Files

| File | Owns |
| --- | --- |
| `app.ts` | `createGitHubConnectorApp`: routes, auth seam, CORS, Git relay for pairing and repository routes, error codes |
| `connection.ts` | Per-principal connection: transactions, grant, pairings and revisions, transfer admission, scoping, refresh |
| `github.ts` | GitHub OAuth token, `/user`, installation, repository-by-id, repository-by-name, and scoped-token calls over an injected fetch |
| `crypto.ts` | Random secrets, secret hashes, PKCE S256, AES-GCM sealing |
| `config.ts` | Bindings type, secret reading, exact callback allow-list |
| `worker.ts` | `GitHubConnection` Durable Object, principal directory, Worker runtime resolver |
| `test-support.ts` | Test-only memory directory and simulated GitHub |

Only `worker.ts` imports `cloudflare:workers`.

## Mounting

`apps/api/worker/index.ts` mounts the connector into the normal hosted API. The
existing cloud-context and bearer middleware establish the verified principal.
The GitHub callback remains state-bound and does not require an Epicenter bearer.
The shared server CORS middleware admits `Git-Protocol` and `Content-Encoding`
preflights before route guards. The connector's route CORS exposes its error
header; clients still use an explicit bearer with `credentials: 'omit'`.

`wrangler.jsonc` binds `GIT_GITHUB_CONNECTIONS` to `GitHubConnection`. Migration
`v5` adds that SQLite Durable Object class and leaves existing authorities and
ledgers intact. The generated deployment types include the binding. The Worker
uses `enable_request_signal` to carry cancellation into upstream requests.

This mount is implemented locally and has not been deployed. Missing connector
credentials return `not_configured`; Epicenter sign-in credentials never provide
a fallback. The browser and native application callers are still separate work.

## Deployment setup

### GitHub App

Create a GitHub App separate from Epicenter sign-in's OAuth app.

- Callback URLs: `https://api.epicenter.so/api/git/github/callback`, and for
  local development `http://localhost:8787/api/git/github/callback`.
- Expire user authorization tokens: on.
- Request user authorization during installation: off. The connector starts
  its own flow, and a callback without its state is refused.
- Webhook: inactive.
- Repository permissions: Contents read and write; Metadata read-only.
- Installable by any account whose people should be able to pair folders.

The connector uses the client id and secret only. It does not use the app's
private key or installation tokens. A user token reaches a repository only
where the app is installed and the person has access.

### Secrets

Use the hosted deployment credentials in Infisical production `/ci`, from the
repository root. The ordinary Wrangler login selects Braden's personal account,
which is a different Worker. Provide secret values through the interactive
input, never command arguments or this documentation. `GIT_GRANT_ENCRYPTION_KEY` must be
32 random bytes encoded as base64 and retained in deployment secret storage.

```sh
infisical run --silent --env=prod --path=/ci -- bun x wrangler secret put GIT_GRANT_ENCRYPTION_KEY --config apps/api/wrangler.jsonc
infisical run --silent --env=prod --path=/ci -- bun x wrangler secret put GIT_GITHUB_CLIENT_ID --config apps/api/wrangler.jsonc
infisical run --silent --env=prod --path=/ci -- bun x wrangler secret put GIT_GITHUB_CLIENT_SECRET --config apps/api/wrangler.jsonc
infisical run --silent --env=prod --path=/ci -- bun x wrangler secret put GIT_GITHUB_APP_SLUG --config apps/api/wrangler.jsonc
```

The slug is public metadata and optional. These commands administer production.
The four bindings were uploaded from Infisical production `/api` through process
input on October 8. Renaming the encryption binding preserved its exact value.
The deprecated `GIT_GRANT_KEY` entry was removed from Infisical and is absent
from the deployed Worker's secret list. Existing social sign-in bindings remain.

When a value is missing or `GIT_GRANT_ENCRYPTION_KEY` does not decode to 32 bytes, every
route answers 503 `not_configured`. Rotating `GIT_GRANT_ENCRYPTION_KEY` makes every
grant fail to unseal; each is deleted at next use and its pairings stay.

### Callbacks

This source allows `https://zhongwen.bradenwong.com/sync` and
`https://todos.epicenter.so/sync` for a deployed API origin. A loopback
`API_PUBLIC_ORIGIN` also allows `localhost` and `127.0.0.1` callbacks on
Zhongwen's port 5207 and Todos's port 5186. The deployed Worker will allow
Todos only after this change is deployed.

## Tests

```sh
bun test apps/api/worker/git-connector
```

`connection.test.ts` drives the core over memory storage. `app.test.ts`
mounts the app behind `@epicenter/server`'s real `requireBearerPrincipal`
with a fixture session resolver. The simulated GitHub seeds `alice`,
`mallory`, and `bob` with installations and repositories. Tests change its
fields to simulate revocation, races with scoping, outages, refresh races,
reinstalled apps, replaced or renamed repositories, unsupported scoping, and
oversized bodies. Like GitHub, it lists a whole installation for a scoped
token but serves the read by id and Git only for the scoped repository. No binding, variable, or request parameter selects it.

## Limits

- Every Git request on a pairing route costs four GitHub REST calls (`/user`,
  installations, scoping, repository read by id), and one on a repository
  route costs five (the read by name as well), plus a refresh when due, and
  one Epicenter session lookup.
  User tokens allow 5,000 REST calls per hour. A fetch or push is several Git
  requests.
- Discovery reads at most 1,000 installations and 1,000 repositories per
  installation.
- There is no endpoint to disconnect GitHub. Revoking the app on GitHub ends
  the grant at next use.
- The 64 MiB response limit caps a single fetch pack, including a first
  clone. The request limit caps compressed bytes; the connector does not
  bound a gzip body's decompressed size.
- Repository creation and a browser or native client are out of scope.
