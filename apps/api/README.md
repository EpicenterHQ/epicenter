# Epicenter API (Hosted Personal Cloud)

> [!CAUTION]
> **Hosted Git answers 503 until R2 LFS is bound.** `resolveArtifactsGitHost`
> returns no host until Artifacts and all four R2 LFS bindings are there
> (`LFS_BUCKET`, `LFS_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`;
> `worker/lfs-store.ts`), and `wrangler.jsonc` binds none yet. Then every push
> and web write goes through the receiver, which refuses any file other than a
> `.md` note or a hidden path unless it is a stored Git LFS pointer. Before
> binding: give the bucket a CORS rule
> for the registered app origins (PUT and GET; headers
> `x-amz-checksum-sha256`, `if-none-match`, `content-type`), or browser
> uploads and downloads fail. See [Hosted Git](#hosted-git).

Epicenter Cloud Worker. Handles authentication, hosted Git, AI inference, and billing for the hosted personal cloud product. Cloud composes `@epicenter/server` by resolving Better Auth users as principals.

This folder is a single Cloudflare Worker deployment: `worker/` (Hono code) and `ui/` (SvelteKit dashboard SPA) ship together. The same app also runs on Bun with Postgres (`server.ts`), which is how you self-host it.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed. If you host a modified version, you share your changes. See [Stack and priorities](#stack-and-priorities) for self-hosting and the trust model below.

Runs on Cloudflare Workers. Folder data syncs over plain Git to a server the
person chooses. This Worker is Epicenter's hosted choice: it mounts
`mountGitHost` from `@epicenter/server` over Cloudflare Artifacts
(`worker/git-repositories.ts`), at `git.epicenter.so/<namespace>/<name>.git`
(ADR-0546). See [Hosted Git](#hosted-git).

The Yjs store sync this Worker used to serve is removed (ADR-0534), and so is
the GitHub connector that relayed a browser's Git to GitHub. Their Durable
Object classes (`StoreAuthority`, `GenerationsLedger`, `GitHubConnection`) are
not migrated away: the Worker carries no migration history, and the next
deploy starts by deleting the existing `api` Worker, which removes every object
those classes stored, then deploys this configuration as a new Worker.

## Why a hub exists

Local-first doesn't mean no server. It means your data lives on your machine and you aren't dependent on a cloud service to function. But some operations genuinely need a single authority: user identity, API key storage, AI proxying. Trying to make every device a peer for these operations led to three failed attempts at distributed key management before we split into hub (central authority) and local (device-side execution).

The hub handles auth, hosted Git, and AI. Local servers handle filesystem access, offline editing, and low-latency operations. Neither tries to do the other's job. See [Why Epicenter Split Into Hub and Local Servers](/docs/articles/why-epicenter-split-into-hub-and-local-servers.md) for the full story.

## Stack and priorities

Hono handles HTTP routing. We originally wanted Elysia: it's faster, the API is more ergonomic, and it runs natively on Bun. But Elysia depends on Bun-specific APIs that don't exist in the Cloudflare Workers runtime, and Workers compatibility was non-negotiable. Hono runs on Cloudflare Workers, Node.js, Deno, Bun, and AWS Lambda, so when the server moved to a second runtime (ADR-0066), the route layer came along for free.

Cloudflare Workers are the hosted deployment target. Routes, auth, AI, Git, and validation are plain runtime-portable Hono; the Worker holds no Durable Objects, and hosted Git repositories live in Cloudflare Artifacts.

Self-hosting is this app's Bun entry, `apps/api/server.ts`, running against
Postgres, with no Cloudflare account. It builds the same `createServerApp` and the same Better Auth
`createAuth` as the Worker, so a self-hosted server has the same sign-in,
sessions, and routes; set `API_PUBLIC_ORIGIN` to its public origin and see
`.env.example` for the rest. It serves the sign-in, consent, and device
pages from the built UI, so build it first with `bun run --cwd apps/api/ui
build` (or point `API_UI_DIR` at a build). The merge gate boots this entry
against Postgres on every pull request (`oauth-server.postgres.test.ts`). ADR-0549 records how auth will work
there. The surfaces that need Worker-only bindings are absent on Bun: the dashboard shell comes from `ASSETS`, account
deletion is a hosted resource sweep, and billing needs the Autumn secret and the
after-response drain. Hosted Git is mounted there over bare repositories on
disk when `GIT_STORE_ROOT` names a directory, and answers 503 when it does not. `runtime-profile.test.ts` is where that
divergence is declared and checked against both entries.

Billing is hosted-only and stays in `apps/api/worker/billing/`; do not extract
it into a shared package or the self-hosted deployment.

Better Auth owns identity and sessions. Hosted Epicenter configures Google,
GitHub, Microsoft, and Apple social sign-in, with optional passkeys and no
email/password flow. The session cookie is the authorization server's own:
sign-in, consent, device approval, and the dashboard's account management
(billing, sign-in methods, account deletion) on this origin.

This Worker is the OAuth 2.1 authorization server of
[ADR-0549](../../docs/adr/0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md),
and every resource it serves accepts only its opaque access tokens: `/v1/*`
takes the API audience and `ai`, Git requests the Git audience with
`folders:read` or `folders:write` and a namespace role or a grant on the
repository, and `GET /api/repos` and the owner's grant routes the Git audience
with `folders:read` (listing) or `folders:write` (granting, revoking). Epicenter hosts no MCP server
([ADR-0578](../../docs/adr/0578-epicenter-hosts-no-mcp-server.md)). The only
bytes it keeps beside Git are hosted repositories' Git LFS objects, in R2
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)). An app reads who signed in from Better Auth's
`/auth/oauth2/userinfo`, which needs `openid`, and answers the email only
with `email`. Browser
apps get a token by authorization code with PKCE as their own client; the
desktop app's pages reach the API through `epicenter send`, which holds the
desktop grant. See [Authorization server](#authorization-server).

## Trust model

Epicenter Cloud is operated by Epicenter, so Epicenter infrastructure is inside
the trust boundary for hosted data. `BETTER_AUTH_SECRET` signs auth cookies,
tokens, and OAuth state; it is not a data encryption root.

Self-hosted deployments move the trust boundary to infrastructure the deployer
operates. Epicenter never holds or sees data stored in a self-hosted deployment,
so self-hosting is functionally zero-knowledge against Epicenter.

That confidentiality covers content, not the wire, and it does not erase three
things a self-hoster should weigh. The operator still sees the metadata around
the bytes (principal id, application id, message timing, size, and IP);
that operator is Epicenter when hosted and you when self-hosted, and even a
future blind server keeps seeing this envelope. And hosted sign-in leans on social OAuth (email/password is
disabled in `base-config.ts`); a self-hosted server registers its own OAuth apps
for the providers it offers. The full
ledger, with the reasoning, is in [docs/trust-model.md](/docs/trust-model.md).

### Why not zero-knowledge?

Zero-knowledge means the server can't read your data. The cost: account recovery doesn't work (the server can't re-derive your key, so a lost key is lost data), search doesn't work (the server can't index ciphertext), AI doesn't work (the server can't read your notes to summarize them), and moving to a new device means transferring the key by hand.

PGP has been trying to make key management practical for thirty years. Signal works because messaging is one-dimensional. The server is a relay that never processes content. Most apps aren't relays. Epicenter needs to search documents, run AI against notes, and let users recover a lost account without losing everything. The relay reads plaintext, which is what makes those features possible; if you want a server that can't read your data, self-host it.

For the full argument:

- [Trust model](/docs/trust-model.md): what the relay sees, the metadata it still sees, and the two deployments
- [Don't Encrypt the Data, Don't Hold It](/docs/articles/20260615T140000-dont-encrypt-the-data-dont-hold-it.md): why the encryption layer was removed and the anchor direction
- [Why E2E Encryption Keeps Failing](/docs/articles/why-e2e-encryption-keeps-failing.md): PGP, Signal, and the structural problem
- [Let the Server Handle Encryption](/docs/articles/let-the-server-handle-encryption.md): the pragmatic alternative
- [If You Don't Trust the Server, Become the Server](/docs/articles/if-you-dont-trust-the-server-become-the-server.md): self-hosting as the clean answer

## Architecture

```
Cloudflare Workers
├── Hono app (worker/index.ts)
│   ├── /auth/*                Better Auth (social login, sessions, passkeys,
│   │                          OAuth 2.1 authorize, token, revoke, device grant)
│   ├── /sign-in               hosted browser sign-in
│   ├── /consent               OAuth consent, with the folder picker
│   ├── /device                device code entry; approval is the consent page
│   ├── /.well-known/*         authorization server and protected resource metadata
│   ├── /api/repos             the caller's repositories, by namespace
│   ├── /api/repos/:ns/:name/grants  the owner's grants: list, grant (PUT), revoke (DELETE)
│   ├── git audience /:namespace/:name.git/*  Git smart HTTP forwarded to Artifacts; with R2 LFS
│   │                          bound, pushes through the receiver, web writes, Git LFS
│   ├── /v1/*                  OpenAI-compatible chat and STT gateways
│   └── /api/billing/*         Autumn (hosted-only, worker/billing/)
│
└── Artifacts (ARTIFACTS binding): one namespace per environment, one Git repository per repository id
```

API keys for AI providers come from Infisical's production `/api` secret sync to this Worker. Clients never receive provider keys. The client sends a session token, the hub validates it and swaps in the real key before forwarding to the provider.

## Development

For the real browser sign-in and billing flow with an isolated Homebrew
Postgres cluster, follow [Local account integration](./ACCOUNT-INTEGRATION.md).

Prerequisites: Bun, local PostgreSQL, and Infisical CLI authentication
(`infisical login`). `bun run dev` pipes secrets from Infisical's dev
environment into Wrangler via `process.env`, so Postgres alone is not enough.
This package owns the hosted API `.infisical.json`; account-wide operator
commands live in `ops`. The monorepo root intentionally has no Infisical config.

`bun dev:api` runs the Worker locally for sign-in, sessions, the dashboard,
AI requests, and billing integration. Wrangler serves local assets and connects
directly to local Postgres. Infisical's `dev /api` supplies provider credentials;
OAuth, AI, and billing still call their external services. For billing tests,
use the Autumn sandbox described in [Local account integration](./ACCOUNT-INTEGRATION.md).
Hosted Git is unavailable in this local process because Artifacts has no local
simulator. Local dev does not require an Artifacts account secret.
For client Git transfers without Cloudflare, use [Todos' loopback demo remote](../todos/README.md#developing).

The launcher rebuilds the hosted UI at startup. After editing that UI while
Wrangler is running, restart the root dev command or run
`bun run --cwd apps/api/ui build`. A leftover sign-in page can use a different
handoff protocol from the current clients.

### Local Postgres setup

The API needs a local PostgreSQL instance for development. The connection string is configured in `wrangler.jsonc` under the Hyperdrive `localConnectionString`.

```bash
brew install postgresql
brew services start postgresql

# Homebrew creates a role matching your macOS username. Create the postgres role and database:
psql -d postgres -c "CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'postgres';"
psql -U postgres -c "CREATE DATABASE epicenter;"

# Push the schema
bun run db:push:local
```

### How database URLs work

Production uses Supabase Postgres in Frankfurt (`eu-central-1`). Better Auth
continues to own Epicenter sign-in; Supabase supplies the database. The runtime
Hyperdrive connection uses the `epicenter_api` role with read and write access
to Epicenter's tables. Migration `0002` adds the OAuth and namespace tables,
so that role needs `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on them before a
deploy that serves the authorization server: the account trigger from `0003`
inserts the personal namespace as the role that inserts the account.

Query caching must stay disabled on that Hyperdrive configuration. This Worker
is the OAuth authorization server, and every resource checks access tokens in
this database on each request; Hyperdrive's default cache (60 seconds, plus 15
of stale reads) would keep a revoked token or a removed member working. A new
configuration is created with `--caching-disabled`, and an existing one is
corrected with `wrangler hyperdrive update <id> --caching-disabled`, which is
a production operation.

The production `/ops` `DATABASE_URL` uses Supabase's session pooler for IPv4
admin access. `drizzle.config.ts` loads the public `supabase-ca.crt` certificate
and verifies the server certificate and hostname. Hyperdrive uses the direct
database endpoint with its encrypted, certificate-validated transport. The
Supabase Data API is disabled; database credentials stay on the server.

There are three layers, each with a different URL source:

| Layer | Source | Used by |
|---|---|---|
| Local dev (runtime) | `wrangler.jsonc` Hyperdrive `localConnectionString` | `bun dev` (wrangler) |
| Local dev (drizzle-kit) | `LOCAL_DATABASE_URL` parsed from `wrangler.jsonc` | `db:push:local`, `db:studio:local` |
| Remote admin | `DATABASE_URL` injected by `infisical run` | `db:migrate:remote`, `db:studio:remote` |

`bun run dev` runs `infisical run -- wrangler dev` with a local-only `--var` override for `API_PUBLIC_ORIGIN`. Wrangler reads required auth bindings from the spawned process via the `secrets.required` config, including `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, so local OAuth uses the Google client stored in Infisical's dev environment. No `.dev.vars` file is produced. Remote database commands use `infisical run` against the prod environment and should be treated as admin operations, not dev mode.

### Running the server

```bash
bun dev              # Local dev server (uses local Postgres)
bun deploy           # Deploy to Cloudflare Workers (the receiver stays off until LFS is bound; see the caution at the top)
bun run typecheck    # Type check
bun run test         # Run tests, each file isolated
```

`bun run test` is also the no-Infisical verification path: with initdb and
pg_ctl on `PATH`, `oauth-server.postgres.test.ts` boots both entries against
disposable Postgres clusters and drives them with real access tokens.

### Authorization server

`@epicenter/server` composes Better Auth's OAuth provider (ADR-0549) on the
`/auth/*` routes only; see `packages/server/README.md` for the policy. This app
names what is deployment-specific:

- **Audiences**, from `resolveOAuthAudiences` in `@epicenter/constants/apps`,
  which the `epicenter` CLI reads too. Hosted, they are
  `https://api.epicenter.so` and `https://git.epicenter.so`. Any other origin
  (local dev, self-host) serves both from itself: `<origin>` and
  `<origin>/git` (ADR-0326). No client registers itself or identifies itself
  by a metadata document: every client is one of these first-party rows.
- **First-party clients**, in `worker/oauth-registrations.ts`. Each browser build is its app id, a public PKCE
  client with its exact `/auth/callback`, consent skipped, target `*`. The
  desktop app is `so.epicenter`, with a loopback redirect on any port and
  `offline_access`. The CLI is `so.epicenter.cli`, with the device grant only
  and `openid`, so `epicenter auth login` can read who approved it from
  userinfo.

Both entries write the registrations for the origin they serve with
`registerFirstPartyClients`, so no migration seeds a client: the Bun entry at
boot, and the Worker, local `wrangler dev` included, once per isolate before
its first `/auth/*` request. The write is idempotent without a transaction, so
isolates that start together converge; `oauth-server.postgres.test.ts` runs
concurrent writers against a fresh database.

Better Auth runs unpatched, at an exact 1.8 beta in the root catalog. The
device page sends a code to `/auth/oauth2/authorize?user_code=<code>`, and the
consent page approves it with its folder choice. Migration
`0005_better_auth_1_8` adds the 1.8 columns. `api` and `git` allow every
first-party scope, so a refresh never narrows the grant (ADR-0565).

`oauth-server.postgres.test.ts` runs the spike's checks (refresh family, grant
target, silent re-authorization, and the end-to-end flows) against both
entries as separate processes on a disposable Postgres cluster: `bun
server.ts`, and the Worker under `wrangler dev --local` with Hyperdrive's
local connection string. `bun run test` runs each test file isolated
(`--isolate`), because `runtime-profile.test.ts` replaces `pg` with a probe.

### Hosted Git

`mountGitHost` serves `<git audience>/<namespace>/<name>.git` and
`GET /api/repos` ([ADR-0546](../../docs/adr/0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md),
[ADR-0547](../../docs/adr/0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md)).
The route authorizes each request from the access token and the namespace
membership, and creates a repository on its first push; `packages/server`'s
README has the routes and refusals. Tables `repository` and
`repository_alias` (migration `0004_hosted_repositories`) hold names, ids,
and the aliases a rename or a move leaves.

The Worker stores each repository in the Artifacts namespace of its
environment (`epicenter-production`; `ARTIFACTS_NAMESPACE`), named by its
immutable id, so a rename or a move never reaches Artifacts and no URL shows
an id. It reaches
`https://<ARTIFACTS_ACCOUNT_ID>.artifacts.cloudflare.net/git/<ARTIFACTS_NAMESPACE>/<id>.git`
with a token it mints and caches per repository and scope: 24 hours, renewed an
hour early, `read` for a fetch and `write` for the receiver's own writes. The
client's token never reaches Artifacts. Git LFS objects live in R2 when the
Worker binds a bucket (`LFS_BUCKET`, `LFS_BUCKET_NAME`, and the
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` pair that presigns transfers;
`worker/lfs-store.ts`); until then hosted Git answers 503. Clone and fetch are
forwarded untouched, in whichever protocol the client asks for; every
push goes through the receiver and every web write through the translator,
over `worker/artifacts-objects.ts`. The Worker's receiver takes a push body of
at most 24 MiB, holds at most 24 MiB of its inflated objects, and reads at
most 5,000 of `main`'s commits to place it (`WORKER_RECEIVE_LIMITS`), so one
push peaks near 48 MiB of a 128 MB isolate and stays within a Paid
invocation's 10,000 subrequests. The Bun entry keeps bare repositories under `GIT_STORE_ROOT`
(`<root>/<id>.git`; clone and fetch through `git http-backend`, every push
through the forward-only receiver, web writes through the translator at
`<repo>.git/epicenter/writes`) and Git LFS objects under `LFS_STORE_ROOT`
(`<root>/<id>/<aa>/<bb>/<oid>`); without `GIT_STORE_ROOT` hosted Git answers
503, and without `LFS_STORE_ROOT` the LFS routes do:

```sh
# with DATABASE_URL and the variables in .env.example set
GIT_STORE_ROOT=/tmp/epicenter/git LFS_STORE_ROOT=/tmp/epicenter/lfs bun run dev:bun
```

Hosted Git is unmetered. The hosted cloud also needs `git.epicenter.so` routed
to this Worker; that is a deploy step, not in this repository's config.

Deploying needs the production-only `ARTIFACTS_ACCOUNT_ID` secret and an account
on the Workers Paid plan, and, once, deleting the existing `api` Worker first:
this configuration has no Durable Object migrations to apply over it. Keep the secret in Infisical's `prod /api`; the
Cloudflare Workers secret sync copies it to the `api` Worker. Artifacts has no
local simulator, so `bun dev:api` removes the `ARTIFACTS` binding, namespace
variable, and required account secret from its local config. Hosted Git answers
503 locally. The [Artifacts integration checks in ADR-0521](../../docs/adr/0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)
used a separate Worker and namespace, and have not been repeated for the
per-id store; run them before the first deploy of ADR-0546. The local launcher
does not enable that integration path.

### Database commands

```bash
bun run auth:generate:remote # Generate Better Auth schema
bun run db:generate      # Generate Drizzle migrations
bun run db:push:local     # Push schema to local Postgres (dev only, use migrations for remote)
bun run db:migrate:remote # Run migrations against remote (via Infisical)
bun run db:studio:local  # Open Drizzle Studio (local)
bun run db:studio:remote # Open Drizzle Studio (remote, via Infisical)
```

See `wrangler.jsonc` for the Artifacts binding, why the Worker has no Durable Objects, and Hyperdrive (Postgres connection pool) configuration.

`auth:generate:remote` writes every Better Auth model into
`packages/server/src/db/schema/auth.ts`; move the OAuth provider's models into
`oauth.ts` beside it before generating a migration.

## License

[AGPL-3.0](../../licenses/LICENSE-AGPL-3.0). The apps, the shared server library, and internal glue are AGPL so that anyone hosting a modified version shares their changes. The embeddable toolkit (`data`, `workspace`, `field`, `sqlite`, `sync`, `ui`, `identity`, `chat`, `agent`, `agent-protocol`) is MIT. This follows the same pattern as Yjs (MIT core, AGPL y-redis), Liveblocks (Apache clients, AGPL server), and Bitwarden (GPL clients, AGPL server).
