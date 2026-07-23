# 0157. Read-only SQL exposes one schema-opaque row relation

- **Status:** Superseded
- **Date:** 2026-07-19
- **Superseded by:** [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md)
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md) by replacing per-lens named table views with one runtime-owned logical relation.
- **Relates:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0156](0156-applications-bring-workspace-lenses-runtimes-own-workspaces-by-id.md)

## Context

ADR-0122 keeps application lenses out of durable SQLite state, but asks each
connection to install one temporary named view per declared table. That works
only while a connection has one privileged lens. Two applications can give the
same table different projected columns, and a browser Worker or desktop Bun
host cannot create either view without receiving application lens data.

The typed table API is the normal access path. The read-only SQL surface exists
for joins, filtering, grouping, and inspection, and currently has no production
caller. This is the cheapest point to keep arbitrary SQL while removing its
dependency on a privileged lens.

## Decision

Every SQLite workspace connection exposes one stable, read-only logical
relation named `records` with exactly these public columns:

```txt
table_key   TEXT
row_id      TEXT
fields_json TEXT
```

The relation is a connection-local TEMP table materialized from canonical
current rows before each query. `fields_json` is the complete canonical JSON
object. The runtime may change its private durable schema without changing
this contract.

Applications query the relation explicitly:

```sql
SELECT
  row_id AS id,
  json_extract(fields_json, '$.title') AS title
FROM records
WHERE table_key = 'notes';
```

`records` contains visible current application rows, including the optimistic
intent overlay for a synchronized replica. It excludes reserved runtime rows,
including the internal KV map. How the runtime materializes that state is
private and may differ between local-only and synchronized owners.

SQL remains read-only. Before execution, the runtime asks SQLite to compile the
same bound statement with `EXPLAIN`. It permits only `OpenRead` instructions
whose database and root-page pair belong to `records`, and rejects
`OpenWrite` and `VOpen`. This structurally refuses access to durable runtime
tables without maintaining a list of their names. SELECT and WITH statements
that read `records`, and scalar queries that open no relation, remain valid.

Table-valued and virtual-table reads are refused, including `json_each` and
`json_tree`, because SQLite represents them with `VOpen` and gives the runtime
no stable portable relation identity to authorize. Scalar JSON functions such
as `json_extract` remain supported. This is an intentional fidelity refusal in
exchange for making `records` the only addressable relation across every
SQLite adapter.

Parameters and raw result rows may cross a browser Worker or desktop HTTP
boundary. A result schema never crosses that boundary: the application
validates returned rows in its own JavaScript realm.

There are no generated `notes`, `recordings`, or other lens-shaped SQL views.
There is no per-lens view namespace, encoded lens identifier, schema hash, or
second SQLite connection created only to host another interpretation.

## Consequences

- Arbitrary read-only joins and aggregates remain available without sending a
  workspace lens to the process that owns SQLite.
- Several applications can query the same raw owner concurrently.
- Queries must spell JSON extraction and filter by `table_key`; `FROM notes`
  convenience is intentionally lost.
- Table-valued JSON traversal is unavailable; callers use scalar JSON
  functions or typed table reads instead.
- SQL callers can observe unknown and nonconforming values because the
  relation exposes honest canonical JSON. Their local result schema decides
  what the application accepts.
- A wrong-typed value remains visible as raw JSON and fails the caller's result
  schema instead of silently projecting to SQL `NULL`.
- The stable relation becomes a public logical SQL contract, while physical
  table names and indexes remain private runtime state.
- Existing SQL tests are replaced before any production dependency forms.

## Considered alternatives

- **Keep one named view per lens.** Rejected because a host would need the lens
  and simultaneous lenses can assign incompatible columns to the same name.
- **Prefix views with an app or lens ID.** Rejected because it creates a view
  registration lifecycle and makes a release-local interpretation part of SQL
  identity.
- **Open one SQLite connection per lens.** Rejected because desktop transport
  would still need the lens, browser storage may constrain concurrent owners,
  and synchronization and document lifecycle would become harder to share.
- **Compile every query from a typed query builder.** Rejected because raw
  SQLite SQL already supplies the advanced read surface and no production use
  has earned another language.
- **Delete SQL entirely.** Rejected because one schema-opaque relation preserves
  arbitrary inspection and composition at small implementation cost.
- **Expose the physical canonical table.** Rejected because runtime storage
  migrations must not become application compatibility events.
