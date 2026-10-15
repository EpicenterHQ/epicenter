# 0521. A folder syncs over plain Git with a token, to a server the person chooses

- **Status:** Proposed
- **Date:** 2026-10-14
- **Relates:** [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) keeps the remote in `remote.origin.url`; [ADR-0533](0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md) names the three hosts an app runs in; [ADR-0488](0488-cloud-folders-use-independent-git-histories.md) gives each synced folder its own repository; [ADR-0489](0489-folder-transfers-happen-only-when-a-person-syncs.md) keeps transfers explicit; [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) syncs only a repository-root data folder.
- **Unbuilt:** the disk store in `apps/self-host`; listing a principal's repositories; LFS routes on the blob stores; the folder engine's LFS client; pushes over the Worker's request limit; hosted sync for installed apps, which comes with moving them to page-engine folders ([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)); a desktop run of Todos syncing with Epicenter.

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
- **The built module, live, on 2026-10-14**, deployed as a throwaway Worker
  with a fixed test principal in place of Better Auth, on its own namespace:
  - Connect created a repository in 5.5 seconds and answered again in 0.7.
    An 81-character repository name was accepted.
  - The binding's errors crossed into the Worker as a plain `Error` with no
    `code`, its kind only in the message (`ArtifactsError: Repository not
    found: <name>.`, `ArtifactsError: repo already exists: <name>`).
  - Chromium on two other origins, as two devices, pushed, fetched, and read
    each other's change through the real browser folder engine in 1.3 to 3.4
    seconds a sync. A wrong token reached the engine as a readable 401.
  - System `git` pushed and cloned with the token as a URL-scoped header from
    its environment, and through Git's own Basic challenge, in about 3
    seconds; another principal's token was refused with 403.
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
git front      git.epicenter.so/<namespace>/<name>.git/*   credential + membership check, CORS, forwarding (ADR-0546)
═══════════════ repository store ═══════════════════════
storage        Artifacts | bare repositories on disk
```

**Epicenter's server implements the contract once, as a Hono module every
deployment mounts.** `mountGitApp(app, { auth, resolveStore })` in
`@epicenter/server`, beside `mountSessionApp` and `mountPersonalAuthorityBlobs`:

| Route | Does |
| --- | --- |
| `GET …/<namespace>/<name>.git/info/refs?service=…`, `POST …/git-upload-pack`, `POST …/git-receive-pack` | checks the credential and namespace membership, then hands the request to the store with only `Authorization`, `Content-Type`, `Content-Encoding`, `Accept`, and `Git-Protocol`; a first push creates the repository; answers 401 itself when there is no `Authorization` |

The routes, their names, the credential, and push-to-create are decided by [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md): `POST /api/git/connect` and its hourly per-repository token are replaced, and the rest of this record holds.

- The Git routes are outside `/api/` because the cookie-CSRF guard on
  `/api/*` would refuse a terminal `git` push, which carries Basic
  credentials and no `Origin`.
- The Git routes check the credential and the namespace themselves
  (ADR-0546). The global trusted-origin CORS answers preflights and decorates
  every response, 401 included. `WWW-Authenticate` is removed when the request
  has an `Origin`, so a browser reads a 401 instead of prompting, and kept for
  a terminal client, which needs the challenge.
- The remote is `https://git.epicenter.so/<namespace>/<name>.git`
  (ADR-0546). The Artifacts store names a repository `<namespace>.<name>`,
  which appears in no URL.
- A store returns `null` where a deployment keeps none: self-host and the API
  on Bun answer connect with 503 `GitUnavailable`.

The repository store is the replaceable part:

```ts
type GitHost = {
  serve(namespace, name, request): Promise<Response>;   // after authorization
  create(namespace, name): Promise<void>;
  list(namespaces): Promise<Repository[]>;
};
```

The Artifacts store creates a repository on `main` on its first push and
mints its own write tokens, 24 hours per repository, cached; they never reach a
client. The upstream URL is
`https://<account>.artifacts.cloudflare.net/git/<artifacts namespace>/<namespace>.<name>.git`,
from the `ARTIFACTS_ACCOUNT_ID` secret and the `ARTIFACTS_NAMESPACE` variable.
The front checks the person's credential and namespace for every store
(ADR-0546).

| Deployment | Runtime | Repository store | Sign-in |
| --- | --- | --- | --- |
| hosted | `apps/api` Worker | Artifacts binding, one namespace per environment | Better Auth |
| self-host | `apps/self-host` | none yet | Better Auth (ADR-0549) |

Hosted Git is unmetered, like hosted blobs. Billing would stay in `apps/api`
as one more `auth` middleware before connect; a token can also reach
Artifacts directly, so a front-only meter could not be complete.

**A build fixes the server an app signs in to, and that server hosts its Git.**
Epicenter's builds sign in to `https://api.epicenter.so`; a self-hoster builds
the same apps with `SELF_HOST_ORIGIN` set, the switch Todos already reads in
`src/lib/platform/auth.browser.ts`. There is no server picker and no stored
choice of server. Apps are static files on their own origins, and anyone may
host them or ship apps of their own; a sync server never serves app pages.
The remote is never part of a build: Connect proposes it (ADR-0546), and the
folder keeps it in `remote.origin.url`.

**The credential for Epicenter's server is an access token from its
authorization server ([ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)):
the browser app sends its own on the Git routes, and on the desktop
`epicenter git-credential` is `git`'s `credential.helper` for the server
(ADR-0546), so no token is passed in `git`'s environment and nothing renews a
token per repository. For any other server, the person enters the URL and a
token, kept on the device for that URL. A desktop page also accepts any
network URL with the person's own Git credentials.

| Server | Desktop page | Browser |
| --- | --- | --- |
| Epicenter's, hosted or self-hosted | yes | yes |
| Forgejo, or any server with CORS on its Git routes | yes | yes |
| GitHub, GitLab, any other | yes, with the person's own credentials | no |

**GitHub is a desktop remote or a one-way backup mirror, never a browser
remote.** Epicenter runs no GitHub relay. Edits made on a mirror are not
merged back.

## Consequences

- Deleted: `apps/api/worker/git-connector/` (the GitHub App, encrypted grants,
  pairings, relay, and `/sync` callbacks) with its Durable Object, whose
  grants are removed when the `api` Worker is deleted and recreated
  (ADR-0534); Todos'
  `GitHubPicker`, `GitHubReturn`, and `/sync`; the browser transport's GitHub
  rewriting; and the desktop's hosted download and relay.
- `git` receives its token from the credential helper over Git's credential
  protocol, so no token sits in a `git` process's environment; the helper is
  one more program the `epicenter` CLI ships.
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
- What a token reaches is its grant's scopes and target ([ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)).
  Installed apps share the desktop app's grant, as they share its origin
  ([ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md)).

## Considered alternatives

- **GitHub first, through an Epicenter relay** (the pairings of ADR-0488 and
  this record's earlier provider per host). The relay sees every byte and holds
  a GitHub grant, a person without GitHub has no sync, and each added host
  repeats an OAuth app, an adapter, and a relay.
- **Forgejo as Epicenter's server.** It brings accounts, CORS, LFS, mirrors, and
  a web interface, but its tokens reach every repository and it does not serve
  `/api/git/connect`, so self-host sign-in would differ from hosted. It stays a
  supported server.
- **Artifacts' own URLs in `remote.origin.url`.** Its Git routes refuse a
  browser's preflight, and every folder's remote would name one storage vendor.
- **The sync server serves the apps.** Apps on one origin share storage with
  each other and with the server's session.
- **A server chosen at run time.** Every server would have to trust every
  app origin for sign-in, every app would need a picker and a stored choice,
  and a crafted link could point an app at a hostile server. A fixed build
  costs a self-hoster one build setting. Moving to another server's build
  starts an empty browser folder, which Connect fills from the server.
- **The desktop app as the server, or a glue repository it merges.** Phone
  changes would wait for a computer that is on and reachable.
- **A native mobile app first.** It avoids CORS, at the cost of two app stores
  and a mobile build of the folder engine; it can follow without changing this
  contract.
