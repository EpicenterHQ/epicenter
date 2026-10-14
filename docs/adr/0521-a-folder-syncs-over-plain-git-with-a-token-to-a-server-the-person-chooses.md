# 0521. A folder syncs over plain Git with a token, to a server the person chooses

- **Status:** Proposed
- **Date:** 2026-10-14
- **Relates:** [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) keeps the remote in `remote.origin.url`; [ADR-0533](0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md) names the three hosts an app runs in; [ADR-0488](0488-cloud-folders-use-independent-git-histories.md) gives each synced folder its own repository; [ADR-0489](0489-cloud-folder-transfers-are-explicit-and-bootstrap-before-opening.md) keeps transfers explicit; [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) syncs only a repository-root data folder.
- **Unbuilt:** `mountGitApp` and its repository store interface in `@epicenter/server`; the Artifacts store in `apps/api`; the disk store in `apps/self-host`; LFS routes on the blob stores; the folder engine's LFS client; the browser transport without GitHub rewriting; Todos' Sync panel in place of its GitHub picker; deleting the GitHub connector and the desktop relays; pushes over the Worker's request limit.

## Context

A browser folder synced only with GitHub. Todos' `GitHubPicker` connected a
repository through `apps/api/worker/git-connector/`, which held a GitHub App
grant per principal. The browser's Git transport rewrote
`https://github.com/<owner>/<name>.git` to
`/api/git/github/repos/<owner>/<name>.git` and the connector relayed every
request with a token scoped to that repository. A desktop page synced any
network URL with the person's own Git credentials (`page_git.rs`). Desktop
installed apps relayed Git through a loopback relay in the Bun host
(`hosted.rs`, `account-git-relay.ts`) to the connector's folder pairings. An
earlier draft of this record proposed one provider per host, each with list,
create, identify, and transfer operations, GitHub first.

GitHub's Git routes send no CORS headers, and neither do GitLab's or
Bitbucket's, so every byte a browser exchanges with them passes through a relay
that holds a third-party credential. A person without a GitHub account had no
sync on any device, and a person with both a browser and the desktop app set up
two different credentials.

Measured on 2026-10-14:

- **Forgejo 15.0.10 (LTS).** isomorphic-git in Chromium, on another origin,
  pushed, cloned, and fetched a private repository across two simulated devices
  once `[repository] ACCESS_CONTROL_ALLOW_ORIGIN` named that origin; `[cors]`
  alone does not cover Git routes. System `git`, `git-lfs`, and a push mirror
  (updated 7 seconds after a push, LFS object included) also worked. Its LFS
  routes send no CORS headers, its 401 carries none, and its push mirror
  force-pushes with the credential stored in the bare repository's
  configuration.
- **Cloudflare Artifacts** (open beta since 2026-10-01). It mints a token for
  one repository, `read` or `write`, living 60 seconds to a year. Its Git
  routes answer a CORS preflight with 401 and no CORS headers. A repository
  holds at most 1 GB and a file at most 32 MB, and there is no LFS. It
  requires the Workers Paid plan: a personal account on the free plan was
  refused with error 10403, and the Epicenter account was eligible. The
  binding has no local emulation.
- **Artifacts behind a Worker front**, on the Epicenter account. A throwaway
  Worker exposed `POST /connect` (create the repository if missing, mint a
  one-hour write token for it) and forwarded `/git/<repo>.git/*` to the
  repository's Artifacts URL, adding CORS and removing `WWW-Authenticate`.
  - Chromium on another origin called `/connect`, then two simulated devices
    pushed, cloned, pushed, and fetched through the front, with Basic (token
    secret as password) and Bearer (whole token) both accepted. Pushes and
    fetches took 0.3 to 1.6 seconds.
  - A wrong token reached isomorphic-git as a readable 401, not a CORS error.
    A token for one repository was refused with 403 on another, for reading
    and for pushing.
  - System `git` cloned the same history through the front and directly from
    Artifacts, and a desktop push through the front appeared in the direct
    clone. The front took 2.7 seconds to clone against 0.7 seconds directly,
    while it looked each repository up through the binding on every request.
  - A 20 MB file pushed through the front in 14 seconds. A 40 MB file was
    refused with `artifacts_git_receive_pack_object_too_large`. A 110 MB push
    was refused with HTTP 413 by the front and accepted directly by Artifacts
    in 64 seconds; 88 MB passed through the front in 54 seconds.
  - Tokens begin `art_v2_` and end `?expires=<unix seconds>`; `create()`
    returns that string, while `createToken()` returns `plaintext` and
    `expiresAt`. A namespace appears with its first repository and was
    removed with `DELETE /artifacts/namespaces/<name>` (204), which the docs
    do not list.
- **A disk store** was prototyped earlier (`apps/api/evidence/folder-git-host`,
  kept in commit `010c22492c`): a Bun router, SQLite repository records, and
  native `git http-backend`, with 134 passing checks against ordinary Git
  clients and fixture accounts.

## Decision

**The contract between an app and its sync server is Git smart HTTP with a
token.** The folder keeps the server's URL in `remote.origin.url`
([ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)).
The token goes in HTTP Basic as the password, or as a Bearer token. A server a
browser syncs with answers preflights on `info/refs`, `git-upload-pack`, and
`git-receive-pack` without credentials, and puts CORS headers on every
response, 401 included.

```text
app            browser | desktop page | Bun            remote URL + token
═══════════════ Git smart HTTP + token (+ CORS) ═══════  everything an app depends on
control plane  POST /git/connect { folder } → { remote, token }     GET /git/repos
git front      /git/<owner>/<folder>.git/*    token check, CORS, forwarding
═══════════════ repository store ═══════════════════════
storage        Artifacts | bare repositories on disk
```

**Epicenter's server implements the contract once, as a Hono module both
deployments mount.** `mountGitApp(app, { repos, blobs, resolvePrincipal, policy })`
in `@epicenter/server`, beside the existing `mountSessionApp` and
`mountPersonalAuthorityBlobs`:

| Route | Does |
| --- | --- |
| `POST /git/connect` | creates the folder's repository if it is missing, then returns its URL and a write token for that repository alone |
| `GET /git/repos` | lists the signed-in principal's repositories |
| `/git/<owner>/<folder>.git/{info/refs,git-upload-pack,git-receive-pack}` | checks the token, adds CORS, hands the request to `repos.serve` |
| `/git/<owner>/<folder>.git/info/lfs/objects/batch` | Git LFS over the existing blob stores |

The repository store is the replaceable part. Its interface settles once the
disk store exists beside the Artifacts store; the Artifacts store needs:

| Need | Artifacts |
| --- | --- |
| find or create a folder's repository | `get` throws for a missing repository, so `create` follows it |
| mint a token for one repository | `createToken(scope, ttl)`; the store passes the token through and Artifacts checks it, so the front holds no token check of its own |
| the upstream Git URL | `https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`, derived from configuration rather than looked up per request |
| forward one Git request | the request with its `Authorization`, `Content-Type`, `Accept`, and `Git-Protocol` headers; the response with `WWW-Authenticate` removed and CORS added |

A disk store checks tokens itself, so the token check sits inside the store,
not in the front.

| Deployment | Runtime | Repository store | LFS bytes | Sign-in | `policy` |
| --- | --- | --- | --- | --- | --- |
| hosted | `apps/api` Worker | Artifacts binding | R2 | Better Auth | Autumn quotas |
| self-host | `apps/self-host` Bun | bare repositories served by `git http-backend` | local blob store or S3 | passkeys | allows everything |

Billing stays in `apps/api`; the module only asks `policy` before creating a
repository or accepting a push.

**Apps are static and choose their server at run time.** Epicenter publishes
official builds, and anyone may host the same files or ship apps of their own.
A sync server never serves app pages: each browser app keeps its own origin, so
its private file system survives a change of server. The server an app signs in
to is the server it syncs with.

**A token reaches one repository and comes from the sign-in.** Connect returns
a write token for one repository, and the app asks for a fresh one with its
session before it expires. A desktop page passes it to its own `git` runs. For
any other server, the person enters the URL and a token they pasted or scanned.
A desktop page also accepts any network URL with the person's own Git
credentials ([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
No app registers as an OAuth client in this version.

| Server | Desktop page | Browser |
| --- | --- | --- |
| Epicenter's, hosted or self-hosted | yes | yes |
| Forgejo, or any server with CORS on its Git routes | yes | yes |
| GitHub, GitLab, any other | yes, with the person's own credentials | no |

**GitHub is a desktop remote or a one-way backup mirror, never a browser
remote.** Epicenter runs no GitHub relay. Edits made on a mirror are not
merged back.

## Consequences

- Deleted once the apps move: `apps/api/worker/git-connector/` (the GitHub App,
  encrypted grants, pairings, relay, and `/sync` callbacks), Todos'
  `GitHubPicker` and `GitHubReturn`, the browser transport's GitHub rewriting,
  `hosted.rs`, and `account-git-relay.ts`.
- One Sync journey on every device: sign in, connect, sync. A person needs no
  GitHub account.
- A token from Epicenter's server reaches one repository and expires. A
  Forgejo token reaches every repository of its person.
- Epicenter holds hosted folders' history: storage, retention, deletion, and
  backups. Self-host gives that to the operator.
- The hosted store is a beta product with 1 GB per repository and 32 MB per
  file. Whispering's audio goes through LFS, which the folder engine
  implements itself: isomorphic-git has no LFS, and `run_git` runs no filters.
- Every browser byte to the hosted server passes through the Worker. One push
  request over about 100 MB is refused with 413 at the front, though Artifacts
  accepts it directly. A sync's push is far smaller; the first push of a large
  existing folder has to be split into several pushes, or made from a desktop
  or agent straight to the Artifacts URL.
- Safari may clear a site's private file system after a week without a visit
  unless the app is installed, which leaves the server's copy as the durable
  one. Unverified.
- Third-party web apps on arbitrary servers need per-app permission and OAuth
  registration before people outside development use them.

## Considered alternatives

- **GitHub first, through an Epicenter relay** (the pairings of ADR-0488 and
  this record's earlier provider per host). The relay sees every byte and holds
  a GitHub grant, a person without GitHub has no sync, and each added host
  repeats an OAuth app, an adapter, and a relay.
- **Forgejo as Epicenter's server.** It brings accounts, CORS, LFS, mirrors, and
  a web interface, but its tokens reach every repository and it does not serve
  `/git/connect`, so self-host sign-in would differ from hosted. It stays a
  supported server.
- **Artifacts' own URLs in `remote.origin.url`.** Its Git routes refuse a
  browser's preflight, and every folder's remote would name one storage vendor.
- **The sync server serves the apps.** Changing servers strands browser data,
  and apps on one origin share storage with each other and with the server's
  session.
- **The desktop app as the server, or a glue repository it merges.** Phone
  changes would wait for a computer that is on and reachable.
- **A native mobile app first.** It avoids CORS, at the cost of two app stores
  and a mobile build of the folder engine; it can follow without changing this
  contract.
