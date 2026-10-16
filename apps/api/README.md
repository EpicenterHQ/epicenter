# Epicenter API (Hosted Personal Cloud)

Epicenter Cloud Worker. Handles authentication, hosted blobs, AI inference, and billing for the hosted personal cloud product. Cloud composes `@epicenter/server` by resolving Better Auth users as principals.

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

The hub handles auth, blobs, and AI. Local servers handle filesystem access, offline editing, and low-latency operations. Neither tries to do the other's job. See [Why Epicenter Split Into Hub and Local Servers](/docs/articles/why-epicenter-split-into-hub-and-local-servers.md) for the full story.

## Stack and priorities

Hono handles HTTP routing. We originally wanted Elysia: it's faster, the API is more ergonomic, and it runs natively on Bun. But Elysia depends on Bun-specific APIs that don't exist in the Cloudflare Workers runtime, and Workers compatibility was non-negotiable. Hono runs on Cloudflare Workers, Node.js, Deno, Bun, and AWS Lambda, so when the server moved to a second runtime (ADR-0066), the route layer came along for free.

Cloudflare Workers are the hosted deployment target. Routes, auth, AI, Git, and validation are plain runtime-portable Hono; the Worker holds no Durable Objects, and hosted Git repositories live in Cloudflare Artifacts.

Self-hosting is this app's Bun entry, `apps/api/server.ts`, running against
Postgres and, for blobs, any S3-compatible endpoint, with no Cloudflare
account. It builds the same `createServerApp` and the same Better Auth
`createAuth` as the Worker, so a self-hosted server has the same sign-in,
sessions, and routes; set `API_PUBLIC_ORIGIN` to its public origin and see
`.env.example` for the rest. The runtime-parity CI boots this entry against
Postgres and S3 on every pull request. ADR-0549 records how auth will work
there. The surfaces that need Worker-only bindings are absent on Bun: the dashboard shell comes from `ASSETS`, account
deletion is a hosted resource sweep, and billing needs the Autumn secret and the
after-response drain. Hosted Git and the folder MCP server are mounted there
over bare repositories on disk when `GIT_STORE_ROOT` names a directory, and
answer 503 when it does not. `runtime-profile.test.ts` is where that
divergence is declared and checked against both entries.

Better Auth owns identity and sessions. Hosted Epicenter configures Google,
GitHub, Microsoft, and Apple social sign-in, with optional passkeys and no
email/password flow. The session cookie is the authorization server's own:
sign-in, consent, device approval, and the dashboard's account management
(billing, sign-in methods, account deletion) on this origin.

This Worker is the OAuth 2.1 authorization server of
[ADR-0549](../../docs/adr/0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md),
and every resource it serves accepts only its opaque access tokens: `/v1/*`
takes the API audience and `ai`, `/api/session` the API audience and
`profile`, Git requests the Git audience with `folders:read` or
`folders:write` and a namespace role, `GET /api/repos` `folders:read`, and
personal blobs the Git audience with `folders:read` or `folders:write`. Browser
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
future blind server keeps seeing this envelope. Blobs land wherever
`BLOBS_S3_ENDPOINT` points, so renting Epicenter's blob service puts your media
in Epicenter's R2 even on a self-hosted instance; point the store at your own S3
to keep media local. And hosted sign-in leans on social OAuth (email/password is
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
│   ├── /device                device approval, with the folder picker
│   ├── /.well-known/*         authorization server and protected resource metadata
│   ├── /api/session           the principal projection
│   ├── /api/repos             the caller's repositories, by namespace
│   ├── git audience /:namespace/:name.git/*  Git smart HTTP, forwarded to Artifacts
│   ├── /v1/*                  OpenAI-compatible chat and STT gateways
│   ├── /api/blobs/personal/:principalId/:visibility owner-pinned hosted blobs (S3-compatible backend)
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
bun run smoke:local  # Runtime-parity smoke with dev auth and fake local env
bun deploy           # Deploy to Cloudflare Workers
bun run typecheck    # Type check
bun run test         # Run tests, each file isolated
```

`smoke:local` is the no-Infisical verification path. It starts `server.dev.ts`,
runs `apps/api/scripts/smoke.ts`, keeps its server log and data directory under a
temporary directory, and skips the blob leg unless `BLOBS_S3_*` points at a
local S3-compatible store.

### Authorization server

`@epicenter/server` composes Better Auth's OAuth provider (ADR-0549) on the
`/auth/*` routes only; see `packages/server/README.md` for the policy. This app
names what is deployment-specific:

- **Audiences**, from `resolveOAuthAudiences` in `@epicenter/constants/apps`,
  which the `epicenter` CLI reads too. Hosted, they are
  `https://api.epicenter.so`, `https://git.epicenter.so`, and
  `https://mcp.epicenter.so/mcp`. Any other origin (local dev, self-host)
  serves all three from itself: `<origin>`, `<origin>/git`, and
  `<origin>/mcp` (ADR-0326).
- **First-party clients**, in `worker/oauth-registrations.ts`. Each browser build is its app id, a public PKCE
  client with its exact `/auth/callback`, consent skipped, target `*`. The
  desktop app is `so.epicenter`, with a loopback redirect on any port and
  `offline_access`. The CLI is `so.epicenter.cli`, with the device grant only
  and `openid`, so `epicenter auth login` can read who approved it from
  userinfo.

Migration `0004_hosted_oauth_registrations` seeds the hosted rows, and
`oauth-server.postgres.test.ts` fails if it drifts from
`buildFirstPartyClients(PRODUCTION_API_URL)`. The Bun entry serves its own
origin, so it writes its registrations at boot with
`registerFirstPartyClients`. `bun dev:api` (local `wrangler dev`) writes none:
run the Bun entry, or call `registerFirstPartyClients` for the local origin,
to sign a client in locally.

A vendored patch of `@better-auth/oauth-provider`, applied by Bun from the
root `package.json` `patchedDependencies`
(`patches/@better-auth%2Foauth-provider@1.7.9.patch`), keys the refresh
family on grant lineage, ends the whole lineage when a refresh token is
revoked, and keeps a refresh token's scopes whole when a refresh names one
audience, so one grant serves both the API and Git. It is meant for
upstream; re-verify it on every Better Auth upgrade.

`oauth-server.postgres.test.ts` runs the spike's checks (refresh lineage, grant
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
`repository_alias` (migration `0005_hosted_repositories`) hold names, ids,
and the aliases a rename or a move leaves.

The Worker stores each repository in the Artifacts namespace of its
environment (`epicenter-production`; `ARTIFACTS_NAMESPACE`), named by its
immutable id, so a rename or a move never reaches Artifacts and no URL shows
an id. It reaches
`https://<ARTIFACTS_ACCOUNT_ID>.artifacts.cloudflare.net/git/<ARTIFACTS_NAMESPACE>/<id>.git`
with a token it mints and caches per repository and scope: 24 hours, renewed an
hour early, `read` for a fetch and `write` for a push. The client's token never
reaches Artifacts. The Bun entry keeps bare repositories under `GIT_STORE_ROOT`
(`<root>/<id>.git`, served by `git http-backend`); without it Git answers 503.
Hosted Git is unmetered. The hosted cloud also needs `git.epicenter.so` routed
to this Worker; that is a deploy step, not in this repository's config.

Both entries also mount the folder MCP server (`mountMcpServer`,
[ADR-0550](../../docs/adr/0550-epicenters-mcp-server-reaches-hosted-folders-through-grants-that-target-namespaces.md))
over the same store, at `<origin>/mcp` on the Bun entry and at
`https://mcp.epicenter.so/mcp` for the hosted cloud, which also needs that
host routed to this Worker. It answers 503 `mcp_unavailable` where Git has no
store. The Worker path has not run against Artifacts.

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

### Local blob storage

Blob storage is optional: omit `BLOBS_S3_*` and the blob routes answer 503
while everything else runs. To exercise blobs locally, run
a real S3-compatible store alongside the server. `compose.yaml` starts
[versitygw](https://github.com/versity/versitygw) (an S3 API over a plain folder)
and creates the `epicenter-blobs` bucket:

```bash
docker compose up -d
```

Then set the `BLOBS_S3_*` values from `.env.example` (endpoint
`http://localhost:7070`). Your blobs land as ordinary files under
`.data/blobs/epicenter-blobs/`.

Clients publish and read through the API authority. Its server-side S3 client
signs exact-key PUT, GET, HEAD, and DELETE requests; object-store URLs and
credentials never reach application rows or browsers. The API limits each
publication to 25 MiB. Browser CORS applies to the API origin, not the bucket.

The server runs the same portable S3 client against versitygw, Garage, AWS S3, or
R2; the store is endpoint-as-config, so swapping it is a config change, never a
code change. There is no filesystem blob backend in the codebase by design: the
self-host story is "run the server next to an S3-compatible service," exactly as
the hosted Worker runs next to R2. `apps/api/scripts/smoke.ts` exercises the full
blob round-trip against whichever store the server points at.

### Database commands

```bash
bun run auth:generate:remote # Generate Better Auth schema
bun run db:generate      # Generate Drizzle migrations
bun run db:push:local     # Push schema to local Postgres (dev only, use migrations for remote)
bun run db:migrate:remote # Run migrations against remote (via Infisical)
bun run db:studio:local  # Open Drizzle Studio (local)
bun run db:studio:remote # Open Drizzle Studio (remote, via Infisical)
```

See `wrangler.jsonc` for the Artifacts binding, the Durable Object migration history, and Hyperdrive (Postgres connection pool) configuration.

`auth:generate:remote` writes every Better Auth model into
`packages/server/src/db/schema/auth.ts`; move the OAuth provider's models into
`oauth.ts` beside it before generating a migration.

## License

[AGPL-3.0](../../licenses/LICENSE-AGPL-3.0). The apps, the shared server library, and internal glue are AGPL so that anyone hosting a modified version shares their changes. The embeddable toolkit (`data`, `workspace`, `field`, `sqlite`, `sync`, `ui`, `identity`, `chat`, `agent`, `agent-protocol`) is MIT. This follows the same pattern as Yjs (MIT core, AGPL y-redis), Liveblocks (Apache clients, AGPL server), and Bitwarden (GPL clients, AGPL server).
