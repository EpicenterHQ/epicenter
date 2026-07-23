# Epicenter API (Hosted Personal Cloud)

Epicenter Cloud Worker. Handles authentication, real-time sync, AI inference, and billing for the hosted personal cloud product. Cloud composes `@epicenter/server` by resolving Better Auth users as principals.

This folder is a single Cloudflare Worker deployment: `worker/` (Hono code) and `ui/` (SvelteKit dashboard SPA) ship together. The self-hosted single-partition instance lives in the sibling `apps/self-host`; it resolves one operator bearer to the literal `instance` principal, has no billing surface, and (because it composes no Better Auth) no Postgres either (ADR-0075, ADR-0076).

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed. If you host a modified version, you share your changes. See `apps/self-host` for the self-hosted reference and the trust model below.

Runs on Cloudflare Workers with one record authority Durable Object per
principal. The bearer selects the principal; the server derives the authority
from that principal alone. Clients submit scalar record intents, publish
route-bound Yjs 14 documents, and transfer record-addressed blobs through the
versioned `/api/sync/v1` surface. There is no client-authored authority id,
workspace catalog, room id, enrollment lookup, or legacy sync route.

## Why a hub exists

Local-first doesn't mean no server. It means your data lives on your machine and you aren't dependent on a cloud service to function. But some operations genuinely need a single authority: user identity, API key storage, AI proxying. Trying to make every device a peer for these operations led to three failed attempts at distributed key management before we split into hub (central authority) and local (device-side execution).

The hub handles auth, sync relay, and AI. Local servers handle filesystem access, offline editing, and low-latency operations. Neither tries to do the other's job. See [Why Epicenter Split Into Hub and Local Servers](/docs/articles/why-epicenter-split-into-hub-and-local-servers.md) for the full story.

## Stack and priorities

Hono handles HTTP routing. We originally wanted Elysia: it's faster, the API is more ergonomic, and it runs natively on Bun. But Elysia depends on Bun-specific APIs that don't exist in the Cloudflare Workers runtime, and Workers compatibility was non-negotiable. Hono runs on Cloudflare Workers, Node.js, Deno, Bun, and AWS Lambda, so when the server gained a second runtime (ADR-0066), the route layer came along for free.

Cloudflare Durable Objects are the hosted authority backend. One
`DataAuthority` serializes a principal's scalar, document, and blob-membership
state in SQLite, while hibernating WebSockets provide live document fanout.
The Bun runtime owns the same authority contract in local SQLite files.
Routes, authentication, policy, and protocol validation remain in the shared
Hono library.

The self-host story uses that same library as a separate deployable:
`apps/self-host` is the single-partition instance, a Bun binary or a
Cloudflare Worker that composes no Better Auth and no Postgres (ADR-0075,
ADR-0076). `apps/api/server.ts` is the hosted cloud on Bun for local development
and runtime-parity checks, backed by Postgres for hosted authentication, local
record authority files, and any S3-compatible blob endpoint.

Better Auth handles identity. Hosted Epicenter requires Google, GitHub, and Microsoft social sign-in (email/password is disabled in `base-config.ts`), plus an OAuth provider plugin that turns the hub into a standards-compliant OAuth server. Desktop and mobile clients authenticate via OAuth/PKCE flows, get a token, and use it for all subsequent API calls and WebSocket connections.

## Trust model

Epicenter Cloud is operated by Epicenter, so Epicenter infrastructure is inside
the trust boundary for hosted data. `BETTER_AUTH_SECRET` signs auth cookies,
tokens, and OAuth state; it is not a workspace encryption root.

Self-hosted deployments move the trust boundary to infrastructure the deployer
operates. Epicenter never holds or sees data stored in a self-hosted deployment,
so self-hosting is functionally zero-knowledge against Epicenter.

That confidentiality covers content, not the wire, and it does not erase three
things a self-hoster should weigh. The relay operator still sees the metadata
around the bytes (principal id, record address, attach endpoint ids, message
timing, size, and IP); that operator is Epicenter when hosted and
you when self-hosted, and even a future blind relay keeps seeing this envelope.
Blobs land wherever `BLOBS_S3_ENDPOINT` points, so renting Epicenter's blob
service puts your media in Epicenter's R2 even on a self-hosted star; point the
store at your own S3 to keep media local. And logging in still leans on Google
OAuth (email/password is disabled in `base-config.ts`), until the first-boot
local bearer token that removes that dependency lands (ADR-0070). The full
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
│   ├── /auth/*          Better Auth (social OAuth, OAuth provider)
│   ├── /v1/*            Inference and transcription gateways
│   └── /api/sync/v1/*   Scalar, document, blob, Backup, and Restore
│
├── DataAuthority        One principal's live record authority
├── DataBackup           One immutable logical Backup
├── DataBackupRegistry   Backup and Restore coordination
└── AttachRelay          Live endpoint-addressed Super Chat relay
```

API keys for AI providers are environment secrets (`wrangler secret put`). They never leave the hub. The client sends a session token, the hub validates it and swaps in the real key before forwarding to the provider.

## Development

Prerequisites: Bun, local PostgreSQL, and Infisical CLI authentication
(`infisical login`). `bun run dev` pipes secrets from Infisical's dev
environment into Wrangler via `process.env`, so Postgres alone is not enough.
This package owns the hosted API `.infisical.json`; account-wide operator
commands live in `ops`. The monorepo root intentionally has no Infisical config.

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
bun test             # Run tests
```

`smoke:local` is the no-Infisical verification path. It starts `server.dev.ts`,
runs `apps/api/scripts/smoke.ts`, keeps its server log and data directory under a
temporary directory, and skips the blob leg unless `BLOBS_S3_*` points at a
local S3-compatible store.

### Local blob storage

Blob storage is optional: omit `BLOBS_S3_*` and the blob routes answer `503
StorageNotConfigured` while everything else runs. To exercise blobs locally, run
a real S3-compatible store alongside the server. `compose.yaml` starts
[versitygw](https://github.com/versity/versitygw) (an S3 API over a plain folder)
and creates the `epicenter-blobs` bucket:

```bash
docker compose up -d
```

Then set the `BLOBS_S3_*` values from `.env.example` (endpoint
`http://localhost:7070`). Your blobs land as ordinary files under
`.data/blobs/epicenter-blobs/`.

Browser replicas upload and download through short-lived presigned object-store
URLs. The bucket CORS policy must allow each trusted application origin to use
`GET` and `PUT`, and must allow the `Content-Type` and `If-None-Match` request
headers. This is deployment configuration, not Worker CORS: a missing
`If-None-Match` allowance makes immutable browser uploads fail at preflight.

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

See `wrangler.jsonc` for Durable Object bindings, KV namespaces, and Hyperdrive (Postgres connection pool) configuration.

## License

[AGPL-3.0](../../licenses/LICENSE-AGPL-3.0). The apps, the shared server library, and internal glue are AGPL so that anyone hosting a modified version shares their changes. Embeddable toolkit packages such as `data`, `document-sync`, `sync`, and `ui` are MIT.
