# Local Books: QuickBooks to SQLite sync CLI

- Status: In Progress
- Date: 2026-06-21 (revised 2026-06-24)
- Supersedes the data-layer intent of `specs/20260620T180000-local-books-agent-over-sql.md` (the agent-over-SQL daemon, the conversation doc, and the tool-approval seam are dropped; see Context). That spec should be retired once this one is in progress.
- The read/write surface over this mirror (the read SQL, live report, and one expense write) is settled in [ADR-0061](../docs/adr/0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md). It ships as standalone CLI verbs (`query`, `report`, `recategorize`), not a daemon: see [ADR-0072](../docs/adr/0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md), which realizes this spec's "the chat agent is off the shelf" call and defers the ADR-0047 daemon. This spec covers only the sync engine beneath those verbs.

## Context

Local Books began as an "agent over SQL" product: a daemon that answered chat questions about your books by running SQL, streaming answers into a synced conversation doc. A design pass collapsed that scope twice.

1. The chat agent is off the shelf. A general local coding agent (Codex or Claude Code) running on the box already queries a local SQLite file with SQL, owns its own tool loop and approvals, and streams its work. You reach it from any device by remote control over a private Tailscale mesh, and the books never leave the box. That removes the need for a bespoke agent loop, a tool-approval seam, and a conversation doc. (Consequence elsewhere: this also removes Local Books as a second consumer of the AI doc-streaming core, so vocab is free to take its clean break.)
2. The data substrate is not off the shelf. Surveyed Node and Rust options: none keep a queryable mirror fresh via incremental CDC. `quickbooks-cli` (Rust) is a query tool with a TTL response cache and no CDC; `quick-oxibooks` is a blocking client. So the one thing worth building is the engine that pulls QuickBooks Online into a faithful local SQLite mirror and keeps it current.

This spec covers that engine only.

## Scope

In scope:
- A headless CLI, `local-books`, that authenticates to QuickBooks Online and maintains a local SQLite mirror.
- Full pull and incremental (CDC) refresh, with the engine choosing the mode from stored state.

Out of scope, deliberately:
- The chat agent and any AI inference (off the shelf).
- Syncing the books across devices, or any CRDT / Yjs. The mirror is box-local and re-pullable.
- Annotations or a user overlay (parked; later an additive table joined on the QB id).
- A GUI or Tauri shell. OAuth uses a localhost-callback flow that needs a browser, not a desktop app.

## Locked decisions

1. **Runtime: Bun.** QuickBooks ships an official OAuth2 library for Node (`intuit-oauth`); the API returns JSON, which matches the raw-blob storage; `bun:sqlite` is built in; `bun build --compile` yields a single binary for a headless box. Not Rust, not Tauri.
2. **Storage model: current-state mirror, not a ledger.** CDC drives upserts into current state; the change stream is the input, never the storage. QuickBooks owns the authoritative history.
3. **Faithful 1-1.** One table per QB entity type. Store the raw QB JSON per object plus a few extracted scalar columns for indexing and joins. New QB fields appear in the blob with no migration.
4. **Sync state lives inside the db, not a sidecar file** (see Architecture: atomicity).
5. **Minimal dependencies.** `intuit-oauth` for the token lifecycle, built-in `fetch` for data and `/cdc`, `bun:sqlite` for storage. Tokens go in the OS keyring, never in the data dir.

## Architecture

### File layout

```
<app-dir>/companies/<realmId>/books.db   # entity tables + _sync_state + _meta
OS keyring (keyed by realmId)            # OAuth tokens
<app-dir>/config.json (optional)         # which entities, schedule; user-authored
```

The app's directory is `<epicenter-root>/apps/local-books`, below the one Epicenter data root that `EPICENTER_DATA_DIR` moves; the app computes no OS application-data path of its own (ADR-0201). Scoping by `realmId` (the QB company id) under `companies/` keeps multiple companies from colliding.

### Entity tables (one per QB type, e.g. `invoices`)

```sql
CREATE TABLE invoices (
  id          TEXT PRIMARY KEY,            -- QB Id
  raw         TEXT NOT NULL,               -- full QB object JSON, verbatim
  updated_at  TEXT,                        -- extracted MetaData.LastUpdatedTime
  synced_at   TEXT NOT NULL,               -- when this row was last written locally
  deleted     INTEGER NOT NULL DEFAULT 0   -- soft-delete from a CDC delete event
  -- plus a few extracted scalar columns per entity for indexing/joins
  -- (e.g. invoices: doc_date, total_amt, customer_ref)
);
```

Soft-delete, not hard-delete: a CDC delete means QuickBooks no longer has the object either, so a local hard-delete would erase the only surviving copy. Keep the blob, flag it; the agent filters `WHERE deleted = 0`.

### Sync state, and why it lives in the db

```sql
CREATE TABLE _sync_state (
  entity            TEXT PRIMARY KEY,  -- 'Invoice', 'Customer', ...
  cdc_cursor        TEXT,              -- ISO timestamp to pass as changedSince next run
  last_full_pull_at TEXT,
  last_synced_at    TEXT
);
CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);  -- realmId, schema_version
```

The cursor must advance in the same transaction that writes the rows it accounts for. A sidecar `.json` cannot join a SQLite transaction, so a crash between "rows written" and "cursor written" either re-pulls (harmless, upserts are idempotent) or, worse, skips data (cursor advanced, rows lost). A `_sync_state` row written inside the upsert transaction makes ingest-and-advance atomic and crash-safe, and keeps the db a single self-contained, copyable artifact.

This is the answer to "colocate data and updated_at": yes, in the same transactional store, not a separate file. User config has no atomicity need, so it may stay a json or flags; secrets go in the keyring.

### Sync algorithm

```
for each configured entity:
  state = _sync_state[entity]
  mode =
    --full flag                            -> FULL
    no cursor (first run)                  -> FULL
    now - cursor > CDC_WINDOW (lossy gap)  -> FULL   (CDC cannot cover the gap)
    last_full_pull_at older than N days    -> FULL   (correctness backstop)
    else                                   -> INCREMENTAL

  FULL:        paginate the QB query API, UPSERT all,
               set cdc_cursor = now, set last_full_pull_at = now
  INCREMENTAL: GET /cdc?entities=<entity>&changedSince=<cdc_cursor>,
               UPSERT changed, mark deletes, set cdc_cursor = now

  all writes for an entity + its _sync_state row commit in ONE transaction
```

This is "cache when we last pulled so a re-run knows how": the stored cursor selects the mode automatically; `--full` overrides; the CDC-window and staleness checks force a full resync when incremental cannot be trusted.

### CLI surface

```
local-books auth                              # one-time OAuth2 (localhost callback), tokens -> keyring
local-books sync [--full] [--entity <name>...]
local-books status                            # per-entity cursor, last full pull, row counts, token expiry
```

Schedule `sync` with cron / launchd / systemd on the box.

## Spike-verify items (do not trust assumptions; ground against QB docs)

- QuickBooks rate limits and throttling; add backoff and a concurrency cap to the full pull.
- The actual CDC lookback window (commonly cited near 30 days) and per-call entity/result caps; these set `CDC_WINDOW` and the force-resync threshold.
- `intuit-oauth` runs clean on Bun; fallback is a hand-rolled OAuth2 authorization-code + PKCE flow.
- ~~The QB entity list to mirror, and which scalar columns are worth extracting per entity.~~ Resolved 2026-06-24 (Move 1, below): the rule is "every posting entity plus the name lists they reference" (16 today), columns are an opt-in ergonomic layer. See `apps/local-books/src/entities.ts`.
- Delete semantics in `/cdc` (confirm deletes are reported, and how).
- **(Move 2)** The max entities accepted in one `/cdc?entities=` request. The batched-CDC pass below assumes the whole mirror set fits in one call; if QB caps it below our set size, chunk into the fewest calls that cover the set (still far fewer than one-per-entity).

## Slices (each ends green and demoable)

1. `auth`: OAuth2 against a QB sandbox company, tokens in keyring, `status` shows token state.
2. Full pull of one entity (`Invoice`) into `invoices` with raw blob + extracted columns; `_sync_state` and `_meta` created.
3. Incremental: `/cdc` since cursor, upsert + soft-delete, atomic cursor advance; mode auto-selection and `--full`.
4. All configured entities; backoff and rate-limit handling; force-resync backstops.
5. `bun build --compile` single binary plus an example launchd/systemd unit.

## Revision 2026-06-24: complete the mirror, then collapse the cursor

A greenfield pass (compatibility pressure released; the mirror is box-local and re-pullable, so it has no durable contract to preserve) settled two changes. Move 1 is landed; Move 2 is specified here for the next implementation pass.

### Move 1 — mirror the full posting closure (landed)

**Product sentence:** the mirror holds every financial fact QuickBooks will hand us; the agent sweeps it relationally and drills into raw blobs; QuickBooks owns the computed opinions (`books_report`).

**Drift it fixed:** the registry curated **9** entities. Because the mirror is the agent's relational, offline surface, a *subset* silently under-reports against the live reports: `Payment` was mirrored but `BillPayment` was not, so "what did I actually pay this vendor" had no row-level answer. Curation was the bug generator.

**The break:** `ENTITY_DEFS` is now a *rule*, not a list — every posting entity (anything that moves money through the GL) plus the name lists those transactions reference. Added `SalesReceipt`, `BillPayment`, `JournalEntry`, `CreditMemo`, `VendorCredit`, `RefundReceipt`, `Transfer` (16 total). Non-posting documents (`Estimate`, `PurchaseOrder`) and config/attachment entities stay out: they carry no money. Extracted columns became an opt-in ergonomic layer — `JournalEntry` ships column-light (its amounts are per-line in `raw`), proving the default is "raw-only, still queryable via `json_extract`."

**Why it was nearly free:** raw is canonical and columns are `GENERATED` projections, so an entity costs one registry entry and zero migration. When adding is free, curating below the full set only manufactures silent holes.

### Move 2 — one realm cursor, one batched CDC call (landed; see ADR-0064)

**Drift it fixed:** §"Sync state" keyed `_sync_state` by entity, each with its own `cdc_cursor`, and §"Sync algorithm" looped entities, issuing one `/cdc?entities=<entity>` call apiece. But CDC's `changedSince` is a *single timestamp for a multi-entity call* that returns a per-entity `changes` map from one request. So a per-entity cursor was N owners for what CDC treats as one value, and with the set at 16 an incremental pass fired 16 sequential CDC calls where one would do.

**As built** (the durable decision is [ADR-0064](../docs/adr/0064-the-local-books-mirror-keeps-one-realm-cdc-cursor-table-existence-is-the-per-entity-init-latch.md)):

- The **realm** owns one cursor in `_meta` (`cdc_cursor`, `last_full_pull_at`, `last_synced_at`). `_sync_state` is **deleted**.
- "Has this entity been full-pulled?" is a **`full_pulled:<Entity>` key in `_meta`**, written in the same transaction as the pull's rows ([ADR-0250](../docs/adr/0250-the-local-books-mirror-artifact-is-the-schema-authority-and-browse-is-a-generic-sqlite-inspector.md), amending ADR-0064's table-existence latch: tables now all exist from open, so existence can no longer carry the signal). Incremental set-extension stays cheap (add an entity → only it backfills, its latch being absent).
- An INCREMENTAL pass backfills any configured entity with no latch (a full query of its history) first, then fires ONE batched `/cdc?entities=<all>` and advances the single cursor in the same transaction as the rows. A realm FULL (`--full` / cursor past the CDC window / staleness backstop) full-pulls every entity (each its own query endpoint — an honest asymmetry) and resets the cursor. The cursor advances only on a clean pass, so any failure (and a partial FULL) re-pulls / re-backfills next time rather than skipping.
- `--entity <name>...` is a targeted FULL repair of those tables that does **not** move the realm cursor.

**Durable-format change, made free by re-pullability:** `SCHEMA_VERSION` is bumped to `2`; on a mismatch the engine drops the derived tables and clears the cursor, forcing one `sync --full` rather than carrying a migration reader for a re-derivable cache.

**`status` surface:** the cursor, last full pull, and last synced are shown once at the realm level; per entity it shows row counts and flags only the uninitialized case (a marker for the one informative state, not a `yes` on 16 lines).

**Trigger to revisit chunking:** if the §spike item finds `/cdc` caps entities-per-call below the mirror set size, split into the fewest covering calls; the realm cursor and whole-batch atomicity are unaffected (apply all chunks under one cursor advance).

### Not in this revision (deferred, Move 3)

A unified `transactions` view (and later a line-level `ledger_lines` view via `json_each` over `raw.Line[]`) so the agent sweeps one normalized ledger instead of UNION-ing the money-movement tables by hand. It is *additive* surface, not a clean break, and the line-level version brushes ADR-0061's "facts not opinions" line (it must explode lines as facts, never sum them into a statement — totals stay with `books_report`). **Trigger:** the first time an agent question needs "all activity hitting account X" or "every money-out line by category" and the per-entity tables force a hand-written multi-way UNION.
