# 0160. Epicenter opens named database definitions

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0156](0156-applications-bring-workspace-lenses-runtimes-own-workspaces-by-id.md), [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md)

## Context

The SQLite API still exposes `Workspace`, `WorkspaceLens`, and the
`@epicenter/workspace` package even though console workspaces and the legacy
root-Yjs runtime are deletion targets. The remaining abstraction is a named
local-first database opened by a long-lived host, with release-local table and
KV interpretations over schema-opaque rows.

## Decision

`Epicenter` is the stateful owner. `defineDatabase({ id, tables, kv })` creates
an inert, release-local `DatabaseDefinition`; `epicenter.open(definition)`
returns a live `Database<D>` exposing `tables`, `kv`, `sql`, synchronization,
and disposal. Definitions do not become canonical schemas and different
definitions with the same ID may view the same owner.

The logical address is `(databaseId, tableKey, rowId)`. The database ID is a
separate namespace component, never a prefix concatenated into a table name.
The property key inside `tables` is the table key and SQL view name. There is no
second prefix, storage name, or SQL-name override. `defineTable` opts into a row
document with `document: true`; tables without that flag expose no document API.

The public package is `@epicenter/database`. `@epicenter/workspace`, its legacy
exports, and compatibility aliases are deleted. Application constants use the
role they hold, such as `whisperingDefinition`; opened values may use the
application name, such as `whispering`.

## Consequences

- `Database` accurately groups table-shaped rows and declared KV without
  pretending either is a literal SQLite table or SQLite key-value store.
- The host owns expensive storage and sync lifecycles; definitions remain cheap
  application-side interpretations.
- Applications and routes migrate from workspace vocabulary to database and row
  vocabulary in one clean break.
- Existing consumers must migrate or leave the build graph before merge. There
  is no period where both packages or noun families are supported.

## Considered alternatives

- **Keep Workspace.** Rejected because the product concept no longer exists and
  would preserve context rot in every API built above it.
- **Call the owner Runtime.** Rejected because it hides the product boundary and
  says nothing about what the object owns.
- **Prefix table keys with the database ID.** Rejected because string encoding
  collapses a real address tuple and creates parsing and collision rules.

