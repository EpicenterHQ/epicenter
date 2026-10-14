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
control plane  POST /api/git/connect { folder } → { remote, token, expiresAt, expiresIn }
git front      /git/<name>.git/*              CORS, header hygiene, forwarding
═══════════════ repository store ═══════════════════════
storage        Artifacts | bare repositories on disk
```

**Epicenter's server implements the contract once, as a Hono module every
deployment mounts.** `mountGitApp(app, { auth, resolveStore })` in
`@epicenter/server`, beside `mountSessionApp` and `mountPersonalAuthorityBlobs`:

| Route | Does |
| --- | --- |
| `POST /api/git/connect` | for the session's principal, finds or creates the folder's repository and returns its URL and a write token for it alone |
| `GET /git/<name>.git/info/refs?service=…`, `POST /git/<name>.git/git-upload-pack`, `POST /git/<name>.git/git-receive-pack` | hands the request to the store with only `Authorization`, `Content-Type`, `Content-Encoding`, `Accept`, and `Git-Protocol`; answers 401 itself when there is no `Authorization` |

- Connect is under `/api/` because a desktop page reaches its server only
  through the host's account relay, which forwards `/api/` and `/v1/`. The
  Git routes are outside it because the cookie-CSRF guard on `/api/*` would
  refuse a terminal `git` push, which carries Basic credentials and no
  `Origin`.
- The Git routes check no session: the token is the credential, and the store
  checks it. The global trusted-origin CORS answers preflights and decorates
  every response, 401 included. `WWW-Authenticate` is removed when the request
  has an `Origin`, so a browser reads a 401 instead of prompting, and kept for
  a terminal client, which needs the challenge.
- The remote is `<server>/git/<name>.git`, built from the deployment's
  configured origin. The Artifacts store names a repository
  `<folder>.<tag>`, `tag` being 16 hex characters of SHA-256 over the
  principal ID, so the principal ID is in no URL and two principals never
  share a repository.
- A store returns `null` where a deployment keeps none: self-host and the API
  on Bun answer connect with 503 `GitUnavailable`.

The repository store is the replaceable part:

```ts
type GitRepositoryStore = {
  connect(principal, folder): Promise<{ name; token; expiresAt }>;
  serve(name, { service, advertisement, headers, body, signal }): Promise<Response>;
};
```

The Artifacts store finds a repository with `get`, creates it on `main` when
`get` reports it missing, and mints a one-hour write token with
`createToken`. It serves without touching the binding: the upstream URL is
`https://<account>.artifacts.cloudflare.net/git/<namespace>/<name>.git`, from
the `ARTIFACTS_ACCOUNT_ID` secret and the `ARTIFACTS_NAMESPACE` variable, and
Artifacts checks the token. A disk store would check tokens itself, so the
token check sits inside the store, not in the front.

| Deployment | Runtime | Repository store | Sign-in |
| --- | --- | --- | --- |
| hosted | `apps/api` Worker | Artifacts binding, one namespace per environment | Better Auth |
| self-host | `apps/self-host` | none yet | passkeys |

Hosted Git is unmetered, like hosted blobs. Billing would stay in `apps/api`
as one more `auth` middleware before connect; a token can also reach
Artifacts directly, so a front-only meter could not be complete.

**A build fixes the server an app signs in to, and that server hosts its Git.**
Epicenter's builds sign in to `https://api.epicenter.so`; a self-hoster builds
the same apps with `SELF_HOST_ORIGIN` set, the switch Todos already reads in
`src/lib/platform/auth.browser.ts`. There is no server picker and no stored
choice of server. Apps are static files on their own origins, and anyone may
host them or ship apps of their own; a sync server never serves app pages.
The remote is never part of a build: `/api/git/connect` returns it, and the
folder keeps it in `remote.origin.url`.

**A token reaches one repository and comes from the sign-in.** Connect returns
a write token for one repository. The folder engine asks the app for a
credential right before each push and fetch with the exact URL it is about to
reach (`credentials` in `@epicenter/folder`), and keeps nothing it is given.
The app gives Epicenter's token only to the remote the server named, renews it
five minutes before `expiresIn` (the server's clock, not the device's) runs
out, and forgets it when the account signs out or changes. Forgetting it is
local: a token already given out stays valid at Artifacts until it expires,
and a transfer already running finishes. In the browser the credential is a Basic header on isomorphic-git's
requests, with no cookies and no redirects. On the desktop the shell passes it
to `git` through Git's environment, never its arguments, as
`http.<origin>.extraHeader` with redirects off and no credential helper, and
only for a push or fetch to the folder's own `https` origin
([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
For any other server, the person enters the URL and a token, kept on the device
for that URL. A desktop page also accepts any network URL with the person's
own Git credentials. No app registers as an OAuth client in this version.

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
  migration `v7` deletes every stored grant on the next deploy; Todos'
  `GitHubPicker`, `GitHubReturn`, and `/sync`; the browser transport's GitHub
  rewriting; and the desktop's hosted download and relay.
- A token in a desktop `git` process's environment is readable by other
  processes of the same user, as the person's other secrets on that account
  are. A credential helper fed over a private channel would hide it from them
  too, at the cost of a bundled helper and its lifecycle; it was not built.
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
- Connect is scoped by principal, not by app: anything holding the person's
  session, including any window the desktop host serves through its account
  relay, can mint a write token for any folder ID. That is acceptable while
  every app is Epicenter's own; installed apps' hosted sync needs per-app
  scoping first.
- Third-party web apps on arbitrary servers need per-app permission and OAuth
  registration before people outside development use them.

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
