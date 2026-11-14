# 0061. Local Books serves row-level facts from the mirror, computed reports live, and writes back through one approved verb

- **Status:** Superseded
- **Date:** 2026-06-24
- **Superseded by:** [ADR-0902](0902-this-repositorys-outside-apps-stay-in-apps.md): Local Books is deleted, and this record is its history.

## Context

Local Books mirrors a QuickBooks Online company into a local SQLite database, kept fresh by Change Data Capture (ADR-0047 makes that mirror an agent-facing data daemon). The mirror earns the word "mirror" because CDC keeps it a faithful, re-pullable projection of QuickBooks' entities. Once an agent could read it with SQL, two pressures arrived: founders want to *ask their books* whole-ledger questions ("what's my burn, my P&L"), and they want to *fix the common mistake* (miscategorized expenses) without leaving the local-first loop.

Neither falls out of the entity mirror for free. A profit & loss is not an entity; it is a GAAP-structured computation QuickBooks owns, over posting types the mirror does not even hold in full (no `SalesReceipt`, `JournalEntry`, `CreditMemo`). And a write is the opposite of a query: it mutates the authoritative source, so it cannot be open-ended SQL.

## Decision

The Local Books agent surface is three tools, each sourced from where its data actually lives, and gated as a capability lattice so the agent is only offered what the daemon can do.

1. **`books_sql_query` reads row-level facts from the local mirror.** Open-ended read-only SQL (a `new Database(path, { readonly: true })` connection is the enforcement). This is the high-volume surface, the only thing that can answer arbitrary filtered/grouped/joined questions over thousands of rows offline.

2. **`books_report` reads computed reports live from QuickBooks** (`GET /reports/<name>`: P&L, balance sheet, cash flow, A/R and A/P aging, trial balance). These are **never mirrored and never cached.** Reports have no CDC, so a cached copy would be a stale snapshot; reconstructing them from mirror rows would silently disagree with QuickBooks. They are one cheap call asked a few times a day, so live is both correct and affordable. The dividing line: mirror the *facts*, ask QuickBooks for the *opinions* it computes.

3. **`recategorize_expense` writes back through one approved verb.** It is a closed, named `defineMutation` (so the client agent loop pauses for approval), never open write-SQL. It is **write-through, not write-to-mirror**: it reads the current `SyncToken` from the mirror, sends a sparse update of the expense-line `AccountRef` on a `Purchase`/`Bill`, and folds QuickBooks' authoritative response back into the mirror. QuickBooks stays the source of truth; the mirror is only ever updated from QuickBooks' reply, and the next CDC sync reconfirms it.

The advertised set is a capability lattice keyed on what the daemon holds: `books_sql_query` always (needs no QuickBooks client); `books_report` when a client is available (`openQb`); `recategorize_expense` when a client is available **and** the daemon is not `readOnly`. `LOCAL_BOOKS_READ_ONLY` withholds the write while keeping both reads, the posture of "let the agent analyze my books, not mutate them." A daemon with no client at all is fully offline, mirror-only.

The QuickBooks client is hand-rolled on `oauth4webapi` plus `fetch`, not an npm QuickBooks SDK.

## Consequences

- "What's my P&L / burn / runway" returns QuickBooks' authoritative number, not a SQL reconstruction we would have to defend. Granular drill-down ("every AWS charge") stays instant and offline on the mirror. The two read tools have honestly different shapes because they serve honestly different needs.
- No report cache exists to go stale or to reconcile. The cost is that report answers require connectivity; that is acceptable because the tool is online when asked.
- The write surface is auditable: a finite verb catalog with typed inputs and an approval pause, rather than an open write channel. A stale `SyncToken` is a 409 that leaves QuickBooks untouched (no clobber of a bookkeeper's concurrent edit), not a silent overwrite.
- The agent never sees a tool it cannot use: a read-only daemon does not advertise the write at all. This makes "read-only" a real capability, not a runtime refusal.
- Hand-rolling keeps the runtime pure-TS and dependency-light so `bun build --compile` stays a single binary, and reuses the token lifecycle already shared with `@epicenter/auth`. The cost is owning a thin QuickBooks client (one `request()` with `query`/`cdc`/`report`/`update`), which is small because the hard parts (refresh, 429 backoff, Result errors) were already solved for the read path.
- Local annotation tools (`mark_reviewed`, `add_note`) over an overlay table remain out of scope; they were judged low-value for this audience (invisible to QuickBooks and the accountant) and are not part of this surface.

## Considered alternatives

- **A report cache (mirror reports like entities).** Rejected: reports have no CDC, so it is a stale snapshot, the cop-out "cache" with none of the mirror's freshness guarantee.
- **Reconstruct reports from the mirror in SQL.** Rejected: requires mirroring every posting type and reimplementing QuickBooks' report engine (accrual vs cash, account roll-ups, sign conventions); any divergence from QuickBooks' number destroys trust in a finance tool. Straightforward sums over fully-mirrored rows can still be answered by `books_sql_query`; only judgment-laden statements go live.
- **A generic "write SQL to QuickBooks" tool.** Rejected: writes are dangerous and must be legible to an approval gate; a closed verb catalog is the safe shape. Reads can be open SQL precisely because they are safe.
- **Mutate the mirror directly, sync up later.** Rejected: it forks the cache from QuickBooks and breaks the re-pullable-mirror invariant. Writes go through to Intuit and return via the same upsert path.
- **An npm QuickBooks SDK (`node-quickbooks`, `intuit-oauth`).** Rejected: both bring their own OAuth/token layer (colliding with the shared `oauth4webapi` manager) and break the single-binary build; the write surface is one POST shape, so a dependency made it harder, not easier.

## Reference

- Implemented in `apps/local-books/src/qb-client.ts` (`update`, `report`), `src/agent/recategorize.ts`, `src/agent/report.ts`, `src/agent/qb-access.ts`, `src/agent/books-actions.ts` (the capability lattice), and `mount.ts`. Builds on ADR-0047 (the mirror as a data daemon). The sync-engine design lives in `specs/20260621T100000-local-books-cli-sync-engine.md`.
