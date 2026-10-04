# 0162. Database definitions install connection-local SQL views

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0157](0157-read-only-sql-exposes-one-schema-opaque-row-relation.md)
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md) by naming the durable visible relation and defining the cross-process installation contract

## Context

The current `sql()` implementation rebuilds a TEMP `records` table from every
visible row before each query. It copies data, makes SQL a stale parallel read
path during the refresh, and exposes a record noun that the platform otherwise
rejects. Application-defined views cannot carry executable TypeBox validators
through browser Worker or Tauri IPC boundaries.

## Decision

The row fold owner transactionally maintains `__epicenter_rows` as the current
visible scalar state whenever confirmed state or local intents change. Typed
reads and SQL read that same relation. Confirmed rows, intents, receipts, and
document logs remain private implementation state; SQL does not reimplement the
fold state machine.

Opening a `DatabaseDefinition` installs one explicit-column read-only `TEMP
VIEW` per declared table on that owner's SQLite connection. The table key is
the view name. Each view selects its rows from `main.__epicenter_rows` and
projects declared top-level JSON fields with base-type guards. Missing, null,
or wrong-base-type values become SQL `NULL`; complete TypeBox validation stays
in the typed JavaScript path. Views have no write triggers.

Same-realm owners derive view DDL directly. Cross-process carriers send only an
internal `SqlViewDefinition`: a validated view name and validated column names
tagged with the finite projection kinds `text`, `integer`, `number`, `boolean`,
or `json`. It contains no schema, validator, JSON path, hash, or SQL text. The
owner revalidates the value and generates all DDL. This type is not exported
from the package root.

TEMP views are installed or replaced when a definition is opened, before
prepared queries run. SQL execution enables `query_only` for the guarded read
and restores the connection's prior state afterward. Tests own view replacement,
prepared-statement invalidation, concurrent definitions for one ID, disposal,
and the exact query-only boundary.

`openDatabaseReader({ definition, filePath })` opens a native file read-only,
checks its identity, installs the same views, and exposes guarded `sql()`.
`database.exportSqliteSnapshot({ filePath })` creates an inert point-in-time
file with scalar rows, persisted named views, and identity metadata, but no
intents, sync authority, row-document logs, or write path.

## Consequences

- SQL no longer copies every row before every query.
- Arbitrary joins use stable table names without a SQL parser or CTE rewriting.
- TEMP-view lifetime is exactly connection lifetime. Reopening deterministically
  reconstructs it from the supplied definition.
- Generic SQLite tools consume an explicit inert snapshot; they do not attach
  to a live runtime file and cannot inherit connection-local views.
- The private transport description is unavoidable across process boundaries,
  but is narrow enough that it cannot become a shadow application schema.

## Considered alternatives

- **Inject CTEs into every query.** Rejected because safely merging `WITH`,
  `WITH RECURSIVE`, comments, collisions, and arbitrary SQLite grammar requires
  a parser and repeats generated SQL at every call.
- **Persist release-local views in the live file.** Rejected because concurrent
  application releases may supply different definitions for the same ID.
- **Send serialized definitions or DDL.** Rejected because the owner needs only
  finite projection facts and must never execute caller-supplied SQL as setup.

