# local-books

Headless CLI that mirrors a QuickBooks Online company into a local SQLite database and keeps it current with incremental Change Data Capture (CDC), then exposes that copy as a few verbs you (or an off-the-shelf coding agent) grill. This is a faithful, re-pullable mirror, not a ledger: QuickBooks owns authoritative history, CDC drives upserts into current state.

Design authority: the sync engine is `specs/20260621T100000-local-books-cli-sync-engine.md` (read it before changing the sync model); the capabilities are [ADR-0061](../../docs/adr/0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md); the standalone-CLI shape (the daemon/chat surface deferred) is [ADR-0072](../../docs/adr/0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md).

## Shape

- Runtime: Bun. `bun:sqlite` for storage, built-in `fetch` for the QB API, `oauth4webapi` for the OAuth2 grants (the same client `@epicenter/auth` uses; we own only the localhost callback and the QuickBooks-specific `realmId`). Runtime deps are pure-TS and dependency-free so `bun build --compile` yields one binary: `wellcrafted` (Result/error idioms), `typebox` (validating untrusted token grants and `config.json`), and `oauth4webapi`. All three are cataloged and used elsewhere in the monorepo.
- One SQLite artifact per company, under `<root>/apps/local-books/companies/<realmId>/`, named `books.v<version>.db` after `MIRROR_VERSION` in `src/db.ts`: the version of the corpus contract this build stores, not the app's release version. `src/db-file.ts` owns the naming, the two opening modes, the version listing, and pattern-scoped `deleteOlderVersions`; the rest of the app owns the version constant, DDL, ingestion, cursors, locking, readiness, and deletion timing (ADR-0247). Opening is non-destructive and never falls back to a lower version: a bump is a new filename, not a migration, so nothing is dropped or unlinked on open and the predecessor is retained until something reclaims it. There is no schema version stamped in the file. See ADR-0197. Bump `MIRROR_VERSION` for a stored-shape change, a changed meaning for a stored column, or a change to which entities `src/entities.ts` can mirror; not for indexes, read-time projections, or app releases. A bump costs one full re-pull, and until that re-pull finishes `status` reports the artifact as `building`, never `ready`. Tokens live in a `0600` `credentials.json` at the app-directory root, never inside a company's mirror db, so the agent's read-only SQL surface can never read them. See ADR-0062. That file is also the connected-company index (it is keyed by `realmId`), which is why there is no `companies.json`; `resolveRealm` in `src/token-store.ts` asks it, the same shape as local-mail's `resolveAccount`. The realm's one CDC cursor lives in the db (`_meta`), not a sidecar, so ingest-and-advance is one transaction; whether an entity has been full-pulled is derived from table existence, so there is no per-entity sync-state table. See ADR-0064.
- One table per QB entity (`invoices`, `customers`, ...): `id`, `raw` (verbatim QB JSON), `updated_at`, `synced_at`, `deleted`, plus a few extracted scalar columns for indexing/joins. New QB fields land in `raw` with no migration.

## Grounded QB constants (verified against developer.intuit.com, 2026-06-21)

- CDC lookback window: 30 days. Past that, CDC cannot cover the gap, so the engine forces a FULL pull. `CDC_SAFE_WINDOW_DAYS` keeps a margin under 30.
- CDC max objects per response: 1000 per entity.
- Rate limits: 500 req/min per realmId, 10 concurrent, 40 batch/min. 429 `ThrottleExceeded` (errorCode 003001) → back off ~60s.
- Deletes: CDC returns deleted entities carrying `status: "Deleted"` + `Id` + `MetaData.LastUpdatedTime`. We soft-delete (`deleted = 1`), never hard-delete: a CDC delete means QB no longer has the object, so the local blob is the only surviving copy.

## CLI

```
local-books auth                                   # one-time OAuth2 (localhost callback), tokens -> credentials.json
local-books sync [--full] [--entity <name>...]     # refresh the local copy
local-books status                                 # connection + per-record-type state
local-books query "<sql>"                          # read-only SQL over the local copy
local-books report <Name> [--start --end --method] # live QuickBooks statement (P&L, balance sheet, ...)
local-books recategorize <Purchase|Bill> <id> --to <accountId>   # the one QuickBooks write
local-books app [--no-open] [--port <n>]           # loopback SPA + same-origin /api over 127.0.0.1 (local-mail's shell)
local-books demo                                   # build + grill a sample company offline
local-books mcp                                    # stdio MCP server: expose the verbs to a coding agent
```

`app` is the loopback browser surface: `src/app.ts` owns lifecycle (realm resolve, per-realm `lock.db`, sync loop, Host check, static serving, `Bun.serve`, browser launch); `src/http/api.ts` owns the Hono `/api` app and exports `ApiApp` (the read verbs go through the same `src/books/*` cores, `recategorize` stays the one write, `readOnly` refuses it at the core). The SPA in `ui/` is a SvelteKit static SPA typed end-to-end by `hc<ApiApp>`. Elysia/Eden is refused for repo coherence; this is `local-mail app`'s shape reused.

Sync mode is chosen from stored state: `--full` / no cursor / cursor older than the CDC window / full-pull staleness backstop forces FULL; otherwise INCREMENTAL.

## Config (env or `<app-dir>/config.json`)

- `QB_SANDBOX_CLIENT_ID` / `QB_SANDBOX_CLIENT_SECRET`, `QB_PRODUCTION_CLIENT_ID` / `QB_PRODUCTION_CLIENT_SECRET` — your Intuit app keys, one keyset per environment (ADR-0108; QuickBooks issues a distinct OAuth client per environment). `--qb-env` picks the keyset by name, resolved lazily at the OAuth/refresh site (`src/qb-credentials.ts` owns `QB_SPEC`; `@epicenter/constants/provider-credentials` owns the mechanism). The name carries the QuickBooks target. Personal local app credentials live in the personal Infisical project at `prod /apps/local-books`, reached through the ignored app-local `.infisical.json` (`infisical run --path=/apps/local-books -- bun run src/bin.ts auth --qb-env sandbox`). A missing keyset fails loudly naming the exact `QB_<ENV>_*` variables. Canonical names live in `.env.example` (pinned by `test/env-example.test.ts`); the old unqualified `QB_CLIENT_ID` / `QB_CLIENT_SECRET` are retired.
- `LOCAL_BOOKS_QB_ENV` — `sandbox` (default) or `production`; the connect-time chooser, equivalent to `--qb-env`. The minted token records its environment and every later command asserts it (`token-manager.ts`), refusing a sandbox token used against production and vice versa.
- `EPICENTER_DATA_DIR` — the one Epicenter data root. The app computes no OS application-data path of its own and lives at `<root>/apps/local-books`, so a CLI run and the desktop host operate on the same books (ADR-0201). There is no per-app override.
- `LOCAL_BOOKS_TOKEN_FILE` — override the token file path (default `<app-dir>/credentials.json`). Used by the test harness and any custom location. The `0600` file store works the same on a desktop, a headless server, an SSH session, and CI, which is what a headless-first tool needs. See ADR-0062.
- `LOCAL_BOOKS_READ_ONLY` — reads only: `query` and `report` stay available, `recategorize` is refused. Whether you run the verbs yourself or hand the mirror artifact to an agent.
- Base-URL overrides (`LOCAL_BOOKS_QB_API_BASE`, `_TOKEN_URL`, `_AUTHORIZE_URL`) point the client at a mock server for tests.

## Capabilities (verbs over the local copy)

The app directory is a place, not an inter-app API (ADR-0201). No other Epicenter app receives a path or a SQLite handle into it, and `query`'s read-only SQL is this app's surface over the file this app wrote, never a generic cross-app reader. A company's books reach another app only as a verb local-books publishes, or as a fact a person promotes into the shared Epicenter data.

The three ADR-0061 capabilities are CLI verbs, each a thin `src/commands/*` adapter over a plain core in `src/books/*` that returns a `wellcrafted` `Result`. Sourcing rule (ADR-0061): read the *facts* (rows) from the local copy, ask QuickBooks for the *opinions* it computes (reports); the local copy is never the write target.

- `src/books/query.ts` — `queryBooks({ site, sql })`: read-only SQL over the **local copy**. Read-only is the connection (`site.openReadonly()`), not a string check; results are row-capped. The high-volume, offline, row-level surface, and the same one an off-the-shelf coding agent uses when pointed at the file.
- `src/books/report.ts` — `fetchReport({ openQb, input })`: a **live** QuickBooks Reports read (P&L, balance sheet, cash flow, A/R + A/P aging, trial balance). Never mirrored, never cached (reports have no CDC, so a cache would be a stale snapshot).
- `src/books/recategorize.ts` — `recategorizeExpense({ openQb, site, input })`: the one QuickBooks write-back. Write-THROUGH, never write-to-mirror: read the `SyncToken` from the local copy, sparse-update the expense line `AccountRef` on a Purchase/Bill via `qb.update(...)`, then fold QuickBooks' authoritative response back in; the next CDC sync reconfirms it. A stale `SyncToken` is a 409, never a clobber. Running the verb is the approval; it is refused under `LOCAL_BOOKS_READ_ONLY`.
- `src/books/status.ts` — `readBooksStatus({ config, realmId, mirror, store })`: the connection + mirror state (token validity, the current artifact's path, any retained predecessors, cursor, per-record-type counts) as a plain object. "Not connected" and "mirror not built" are reported states, not errors. The `status` verb formats it for a human; the MCP `status` tool returns it verbatim.
- `src/books/qb-access.ts` — `createQbAccess` lazily opens a QB client from the realm's token store, so `report` and `recategorize` hold no credentials directly.

The verb-core seam is deliberate (ADR-0072): a consumer re-exposes the same `src/books/*` cores without a rewrite. The first such consumer is the MCP server (`src/commands/mcp.ts`, the `mcp` verb), the egress airlock to foreign hosts (ADR-0073): each tool's TypeBox input *is* its MCP `inputSchema` (TypeBox is JSON Schema at runtime), and each `run` maps straight onto a core. It is deliberately **not** `defineActions` and **not** on the mesh: Local Books is standalone (ADR-0072) and its financial data must never touch the relay (ADR-0004), so the only correct exposure is a local stdio subprocess reading the SQLite directly. Each tool's effect class rides the standard MCP `annotations` (`readOnlyHint`/`destructiveHint`: only the QuickBooks write-back is destructive), and read-only mode drops `recategorize` from the catalog (the core refuses too). The only added dependency is `@modelcontextprotocol/sdk` (stable v1, low-level `Server`); `bun build --compile` stays a single binary, and there is still no `@epicenter/app/store` / `@epicenter/chat` dependency.

## Testing

`bun test` boots a mock QB server (`test/mock-qb-server.ts`) and drives the real command paths against it (seeded token file), so full pull, incremental CDC, cursor advance, and soft-delete are proven end-to-end without a live sandbox. The interactive browser hop of `auth` is the only piece a live sandbox is needed for. The verb cores are tested directly in `src/books/*.test.ts`; the verbs through the binary in `test/books-cli.test.ts` and `test/grill-e2e.test.ts` (sync then grill). `test/mcp-server.test.ts` spawns the `mcp` subcommand and drives real JSON-RPC over stdio: it asserts the two error channels (unknown tool is a protocol error, a failed tool is an `isError` result), the read-only gate, and a clean stdout (stdout is the protocol channel, so a stray byte corrupts framing).
