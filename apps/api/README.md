# Epicenter API (hosted services)

The API hosts sign-in, AI inference, transcription, and billing. A person's Epicenter lives on their [home](../../docs/adr/0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md).

This folder is a single Cloudflare Worker deployment: `worker/` (Hono code) and `ui/` (SvelteKit dashboard SPA) ship together. The same app also runs on Bun with Postgres (`server.ts`), which is how you self-host it.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed. If you host a modified version, you share your changes. See [Stack and priorities](#stack-and-priorities) for self-hosting and the trust model below.

## Stack and priorities

Hono handles HTTP routing. We originally wanted Elysia: it's faster, the API is more ergonomic, and it runs natively on Bun. But Elysia depends on Bun-specific APIs that don't exist in the Cloudflare Workers runtime, and Workers compatibility was non-negotiable. Hono runs on Cloudflare Workers, Node.js, Deno, Bun, and AWS Lambda, so when the server moved to a second runtime (ADR-0066), the route layer came along for free.

Cloudflare Workers are the hosted deployment target. The routes, auth, and AI gateways run on both Hono runtimes.

Self-hosting is this app's Bun entry, `apps/api/server.ts`, running against
Postgres. It serves the same sign-in and AI routes as the Worker. Set
`API_PUBLIC_ORIGIN` to its public origin and see `.env.example` for the
other settings. Build the sign-in, consent, and device pages with
`bun run --cwd apps/api/ui build` or set `API_UI_DIR` to an existing build.
The Worker serves the dashboard and meters AI usage through Autumn.
`runtime-profile.test.ts` checks which routes each entry serves.

Billing is hosted-only and stays in `apps/api/worker/billing/`; do not extract
it into a shared package or the self-hosted deployment.

Better Auth owns identity and sessions. Hosted Epicenter configures Google,
GitHub, Microsoft, and Apple social sign-in, with optional passkeys and no
email/password flow. The session cookie is the authorization server's own:
sign-in, consent, device approval, and the dashboard's account management
(billing, sign-in methods, account deletion) on this origin.

This Worker is the OAuth 2.1 authorization server of
[ADR-0549](../../docs/adr/0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md),
and issues opaque access tokens for chat and transcription under `/v1/*`.
Both gateways require the API audience (the deployment's own origin) and
the `ai` scope. Apps use `/auth/oauth2/userinfo` to read who signed in.
It requires `openid` and returns an email address when the grant includes
`email`.


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
│   ├── /consent               OAuth consent
│   ├── /device                device code entry; approval is the consent page
│   ├── /.well-known/*         authorization server and protected resource metadata
│   ├── /v1/*                  OpenAI-compatible chat and STT gateways
│   └── /api/billing/*         Autumn (hosted-only, worker/billing/)
│
└── Hyperdrive (HYPERDRIVE): Postgres for accounts, sessions, and OAuth grants
```

API keys for AI providers come from Infisical's production `/api` secret sync to this Worker. Clients never receive provider keys. The client sends an OAuth access token, the hub validates it and swaps in the real key before forwarding to the provider.

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
to the account and OAuth tables.

Query caching must stay disabled on that Hyperdrive configuration. This Worker
is the OAuth authorization server, and every resource checks access tokens in
this database on each request; Hyperdrive's default cache (60 seconds, plus 15
of stale reads) could admit a revoked token. A new
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
bun deploy           # Deploy to Cloudflare Workers
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

The hosted origin is `https://api.epicenter.so`. The Worker and its local
development scripts use the origins in `site.ts`. Bun defaults to port
8788 and allows a public origin override.

`worker/oauth-registrations.ts` declares the registered OAuth clients.
Browser clients use their exact callbacks with PKCE. Native clients,
including Whispering, use a loopback callback and may request
`offline_access` for a grant independent of the browser session. The CLI
client uses the device grant and asks for consent. All clients are
registered by this deployment.

Both entries write the registrations for the origin they serve with
`registerFirstPartyClients`, so no migration seeds a client: the Bun entry at
boot, and the Worker, local `wrangler dev` included, once per isolate before
its first `/auth/*` request. The write is idempotent without a transaction, so
isolates that start together converge; `oauth-server.postgres.test.ts` runs
concurrent writers against a fresh database.

Better Auth runs unpatched, at an exact 1.8 beta in the root catalog. The
device page sends a code to `/auth/oauth2/authorize?user_code=<code>`, and the
consent page approves it.

`oauth-server.postgres.test.ts` runs the spike's checks (refresh family,
consent, silent re-authorization, and the end-to-end flows) against both
entries as separate processes on a disposable Postgres cluster: `bun
server.ts`, and the Worker under `wrangler dev --local` with Hyperdrive's
local connection string. `bun run test` runs each test file isolated
(`--isolate`), because `runtime-profile.test.ts` replaces `pg` with a probe.

### Retired folder storage

[ADR-0894](../../docs/adr/0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md)
removes the folder routes and the Worker's R2 binding. The folders audience
and the `folders:*` scopes stay registered for now. The historical migrations still create `folder`, `folder_member`,
`folder_invitation`, `folder_app`, `blob`, `change`, `change_file`,
`file`, and `mark`. Their Drizzle definitions are gone. Dropping the
tables is a separate operation.

### Database commands

```bash
bun run auth:generate:remote # Generate Better Auth schema
bun run db:generate      # Generate Drizzle migrations
bun run db:push:local     # Push schema to local Postgres (dev only, use migrations for remote)
bun run db:migrate:remote # Run migrations against remote (via Infisical)
bun run db:studio:local  # Open Drizzle Studio (local)
bun run db:studio:remote # Open Drizzle Studio (remote, via Infisical)
```

See `wrangler.jsonc` for the Hyperdrive connection pool configuration.

`auth:generate:remote` writes every Better Auth model into
`packages/server/src/db/schema/auth.ts`; move the OAuth provider's models into
`oauth.ts` beside it before generating a migration.

## License

[AGPL-3.0](../../licenses/LICENSE-AGPL-3.0). The apps, the shared server library, and internal glue are AGPL so that anyone hosting a modified version shares their changes. Every package is AGPL; see `docs/licensing/licensing-strategy.md`.
