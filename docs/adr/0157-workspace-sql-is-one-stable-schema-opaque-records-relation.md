# 0157. Workspace SQL is one stable schema-opaque records relation

- **Status:** Proposed
- **Date:** 2026-07-19
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md) at the SQL lens boundary: the per-declared-table connection-local `TEMP VIEW` projection is replaced. The portable logical snapshot, private physical SQLite files, read-only posture, and no-persisted-index rules stand unchanged.
- **Relates:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), [ADR-0132](0132-workspace-kv-is-one-reserved-immortal-row.md), [ADR-0156](0156-a-workspace-opens-as-release-local-lens-views-over-one-schema-opaque-owner.md)

## Context

ADR-0122 prescribed one explicit-column `TEMP VIEW` per declared table,
projecting canonical JSON through release-local names with base JSON type
guards. The shipped implementation already deviates from its letter: because a
synchronized workspace's visible state is confirmed rows plus an optimistic
intent overlay, `sql()` materializes per-lens TEMP projection tables on every
call and layers the named views over those copies. Under ADR-0156, several
lenses may coexist over one owner connection, and per-lens named views
conflict structurally: two lenses declaring `notes` with different fields
would fight over one view name, and installing any lens-shaped view requires
shipping the lens to where SQLite lives, which the boundary rule forbids.
Today's statement guard also blocks `__epicenter*`, `sqlite_*`, and `pragma_*`
names but not runtime tables such as `rows` and `intents`, so the private
physical layout leaks into the ad hoc query surface. There are no production
SQL callers; only tests exercise `sql()`.

## Decision

`sql()` exposes exactly one stable, runtime-owned, read-only relation:

```sql
records(table_key TEXT, row_id TEXT, fields_json TEXT)
```

It contains the visible current application rows of the open workspace
(confirmed state plus the optimistic overlay when synchronized). Reserved
runtime rows, including the `__epicenter_kv` map row, are excluded. Every
other relation name is refused: application table keys never become named SQL
relations, and the runtime's physical tables are unreachable from `sql()`.
Queries remain single read-only SELECT statements under `PRAGMA query_only`.

Result typing is app-side: the caller supplies a TypeBox result schema and the
lens-owning surface validates each returned row against it, exactly where row
projection already happens under ADR-0156. The SQL layer performs no
lens-derived projection, type guarding, or column naming. How the runtime
materializes visible state behind `records` (refresh-on-read TEMP projection,
a direct view for local-only workspaces, or something better) is private
runtime state per ADR-0122 and may change without a new decision.

## Consequences

- The lens never reaches the SQL layer, so `sql()` composes with multi-lens
  coexistence and with schema-opaque Worker and desktop boundaries for free.
- `FROM notes` convenience is lost, deliberately. Callers write
  `WHERE table_key = 'notes'` and `json_extract(fields_json, '$.title')`
  instead of named typed columns. The per-column base-JSON-type guards are
  also lost: a wrong-typed stored value now surfaces as its raw JSON and
  fails the caller's result schema loudly instead of projecting to SQL
  `NULL` silently. Joins survive as self-joins on `records`. Today this costs
  only test rewrites; a future product that earns named typed relations must
  bring its own decision, and nothing here forecloses building it app-side
  over `records`.
- Per-lens view installation, per-table projection tables, the projected
  CASE-column generator, and the JSON-type mapping table are deleted from the
  canonical rows module. One relation replaces N-per-lens machinery.
- The one relation is an honest contract: its three columns mirror the
  portable logical snapshot shape from ADR-0122, so a query written against
  `records` reads the same logical state an export would carry.
- `records` becomes a reserved name only at the SQL surface. An application
  table keyed `records` remains legal data; it appears as a `table_key`
  value, not as a relation.

## Considered alternatives

- **Keep per-lens views, namespaced by a lens hash.** Rejected because it
  leaks lens identity into SQL session state and reintroduces the equality
  negotiation ADR-0156 refuses.
- **One view per table key, shared across lenses.** Rejected because
  coexisting lenses disagree about columns for the same key, and any
  column-shaped view still requires a lens where SQLite lives.
- **Fold the sync overlay in SQL with a UNION view.** Rejected because
  set/unset intent folding is JSON surgery that SQL cannot express honestly;
  the fold belongs to the replica code that owns it.
- **Expose the physical `rows` and `intents` tables directly.** Rejected
  because it binds callers to private physical layout ADR-0122 keeps
  evolvable, and `rows` alone misses the visible overlay.
- **Delete `sql()` entirely.** Considered seriously given zero production
  callers; rejected because an ad hoc read surface over one schema-opaque
  relation is nearly free to keep, is already load-bearing in tests, and is
  the natural seam for future query products.
