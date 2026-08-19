# 0250. The local-books mirror artifact is the schema authority, and browse is a generic SQLite inspector

- **Status:** Accepted
- **Date:** 2026-08-19
- **Amends:** [ADR-0064](0064-the-local-books-mirror-keeps-one-realm-cdc-cursor-table-existence-is-the-per-entity-init-latch.md): the per-entity init latch moves from table existence to a `_meta` key; the one-realm-cursor decision stands.

(Provisional number; reconcile at merge.)

## Context

`src/entities.ts` held a typed column registry (`EntityDef`, `GeneratedColumn`,
`col()`, branded `SqlIdent`/`JsonPathSegment`) that generated the DDL and also
fed the browse UI its column headers over HTTP. That made the TypeScript
declaration the schema authority and the database a projection of it, with ~120
lines of machinery before the first QuickBooks fact. Reading the schema from the
database instead was blocked twice: `pragma_table_info` hides generated columns
(only `table_xinfo` sees them, as `hidden` 2/3), and an entity that had not been
full-pulled had no table at all, because ADR-0064 used table existence as the
per-entity init latch, so a fresh mirror could not describe itself.

## Decision

The mirror artifact is the schema authority. `entities.ts` states the schema as
raw longhand DDL (`MIRROR_SCHEMA`) plus a QuickBooks-name-to-table sync mapping
(`ENTITY_TABLES`), and `openBooksDb` runs the whole script, so an artifact's
schema is a pure function of `MIRROR_VERSION` from the moment the file exists,
pulled or not, and independent of config narrowing. The per-entity init latch
becomes a `full_pulled:<Entity>` key in `_meta`, written in the same ingest
transaction as the rows of the pull it records. The browse surface is a generic
SQLite inspector: tables from `sqlite_master`, columns from
`pragma_table_xinfo`, rows from explicit SELECTs, with a request's table name
resolved against `sqlite_master` before any interpolation. The typed column
registry, its branding machinery, and the curated `columns` wire shape are
deleted; nothing outside the DDL declares a column.

## Consequences

- One schema representation. Adding an entity is a CREATE TABLE and a mapping
  entry in one file (plus the `MIRROR_VERSION` bump ADR-0197 already charges);
  the browse UI picks up new tables and columns with zero code.
- The browse UI shows the artifact as it is: every table including `_meta`,
  every column including bookkeeping, `raw`, and generated projections. The
  curated entity view (QB names, registry-selected columns) is refused; the
  domain verbs (status, report, recategorize) keep their own surfaces.
- A half-finished full pull now honestly reads as uninitialized: rows land but
  the latch only commits with a completed pull, where table existence latched at
  first ingest. ADR-0064's self-healing backfill and single realm cursor are
  unchanged.
- `MIRROR_VERSION` bumps to 2 (eager schema, `_meta` latch,
  `invoices.doc_date` renamed `txn_date` to match the other transaction
  tables), which costs the one full re-pull a bump always costs; v1 artifacts
  are retained untouched under their own filename (ADR-0197, ADR-0247).
- Foreclosed: per-request column curation on the wire, and any schema fact that
  lives only in TypeScript. A future curated view must be derived client-side
  or earn a new decision.

## Considered alternatives

- **Keep the registry, feed the UI from it.** Two schema authorities; the
  database could not describe itself and every column change touched TypeScript.
- **Feed the UI from pragma but keep lazy table creation.** The empty state of
  an un-pulled entity renders blank, exactly where headers are most useful, and
  the latch stays entangled with the schema.
- **A columns-as-record registry (name to type/path pairs).** Smaller than
  `col()` but still a second representation of what the DDL already states.
