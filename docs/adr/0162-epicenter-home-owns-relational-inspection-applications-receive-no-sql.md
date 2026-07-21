# 0162. Epicenter Home owns relational inspection; applications receive no SQL

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0157](0157-read-only-sql-exposes-one-schema-opaque-row-relation.md)
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md)

## Context

Applications need typed local reads. People and agents also need to inspect one
Epicenter as familiar tables and issue ad hoc relational queries across them.
Giving every application a SQL escape hatch would couple product code to
private storage and create a second untyped application API. Refusing all live
inspection, however, would make Epicenter Home unable to explain the data that
the platform exists to curate.

## Decision

Application-facing `Epicenter` APIs expose typed tables and values only. They
expose no `sql()` method, raw SQLite connection, query builder, projection DTO,
CTE injection, TEMP view, persistent application view, or native-reader
contract.

Epicenter Home owns relational inspection as a trusted host capability. It can
inspect a live Epicenter through that Epicenter's storage owner, or inspect an
inert portable Epicenter artifact. It does not hand applications a connection
to a private live file. Human and agent inspection use the same logical model
and the same installed Lens catalog.

The stable raw inspection relations preserve structured addresses:

```sql
rows(
  namespace_key,
  table_key,
  row_id,
  fields_json,
  document_update_v2 BLOB NULL,
  blob_sha256 TEXT NULL
)
values(namespace_key, value_key, value_json)
```

Their natural keys are `(namespace_key, table_key, row_id)` and
`(namespace_key, value_key)`. This is a logical contract, not a promise that the
private live store uses these physical tables. A live implementation may use a
different schema, compact identifiers, or another adapter representation.

`document_update_v2` contains one self-contained compact Yjs V2 update produced
from the complete document, never a state vector or concatenated live update
log. `NULL` means no document state has ever been persisted for the row.
`blob_sha256` records the accepted bytes in the row's universal zero-or-one blob
slot. Both columns are platform-owned structural state outside Lens fields.

Lenses let Home render typed tables over these relations. The naming and
lifetime of optional Lens-generated SQL views remain open. This ADR does not
choose installation-folder aliases, persistent views, TEMP views, CTEs, or a
query-rewriting scheme.

## Consequences

- Typed application reads may use private SQL and the canonical address index
  internally. Additional index-backed reads require the separately owned
  decision described by ADR-0176.
- Home can offer a table browser and SQL console without granting applications
  arbitrary SQL or stabilizing the private live schema.
- Raw queries can always address honest namespace, table, value, and row
  coordinates even before friendly Lens views are designed.
- A portable artifact and a live Epicenter expose the same logical data model,
  while only the live Epicenter has an owner and active runtime behavior.

## Considered alternatives

- **No live relational inspection.** Rejected because trusted human and agent
  inspection is a core Epicenter Home responsibility, not merely an offline
  recovery operation.
- **Expose the private live SQLite file.** Rejected because a physical adapter
  layout is not the logical Epicenter and may change independently.
- **Read-only `sql()` guarded by parsing or `EXPLAIN`.** Rejected because it is
  still a second application query language over private storage.
- **Freeze friendly Lens SQL views now.** Deferred until view naming, Lens
  discovery, collision behavior, and ephemeral lifetime are considered
  together.
