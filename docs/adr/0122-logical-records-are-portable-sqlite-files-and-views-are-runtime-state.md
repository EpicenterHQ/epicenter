# 0122. Logical records are portable; SQLite files and views are runtime state

- **Status:** Accepted
- **Date:** 2026-07-15
- **Relates:** ADR-0119, [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0096](0096-local-workspace-persistence-is-environment-injected.md)

## Context

Epicenter needs one portable record image for synchronization, ownership export,
Browser OPFS, Bun, and self-hosted storage. A physical SQLite file also contains
runtime layout, indexes, connection state, actor identity, cursors, and pending
intent. Application releases additionally need named SQL relations over
schema-opaque JSON without persisting one release's lens into shared data.

## Decision

The portable record format is a logical current-state snapshot of
`(table key, row id, JSON payload)`. It carries no SQLite pages, application
schema, lens hash, actor, cursor, outbox, receipt, derived index, or mutation
history. A synchronization checkpoint adds only its accepted sequence, actor
high-water marks, chunk manifest, and integrity data.

A workspace ownership export includes a document manifest beside that record
snapshot. Each document entry retains its declaration, format, canonical domain
parameters, and update-file path. A parameter digest may name a safe file, but
it is not the only recoverable address.

Each environment materializes that logical state in a private SQLite file. The
runtime may evolve its physical tables and sync metadata in place because those
changes do not reinterpret user data. The live file path is never a public
writable capability or portable import format.

On every SQLite connection acquisition, the opened release installs one
explicit-column `TEMP VIEW` per declared table. A view projects canonical JSON
keys through release-local names and base JSON type guards. It is read-only,
connection-local, automatically removed at connection close, and reflects
canonical commits immediately because it stores no rows.

The SQL lens is a projection, never the validation verdict. It prevents
coercions that fabricate values, but full `field.*` refinements remain in the
typed JavaScript read path. Missing, JSON null, and wrong base JSON types project
to SQL `NULL`. Storage-shaped SQL results expose booleans as `0 | 1` and
structured values as JSON text.

Views never receive `INSTEAD OF` triggers. All writes use typed table methods or
named actions. Table and field names are validated at definition time against
the safe SQL identifier and SQLite JSON-path subset. Runtime-internal names and
`sqlite_*` are reserved, and internal queries qualify their schema explicitly
so TEMP shadowing cannot redirect them.

V0 persists no lens-derived index, generated column, materialized table, FTS
index, projection file, generation, or projector cursor. The canonical file
never stores a release-local lens artifact. A future measured optimization must
live in independently disposable runtime state and receive its own decision;
there is no generic sidecar or indexing API now.

An external SQLite reader receives only an explicit inert point-in-time
snapshot. A projection-only snapshot may materialize the current release's
views for convenience, but editing it grants no authority and it is never
applied generically.

## Consequences

- Browser, Bun, and server adapters may use different private SQLite layouts
  while sharing one logical snapshot and record wire.
- A new connection recreates current columns. There is no stale view schema to
  refresh on page reload or application update.
- Canonical writes and pulled sync changes need no projector notification,
  rebuild, polling loop, or lens revision. Private commit hints may still
  invalidate UI queries.
- Query performance initially follows JSON scans within one table-key range.
  The canonical `(table key, row id)` primary key is the only required index.
- Full validation remains coherent across platforms because SQL does not try to
  reimplement TypeBox, URI, date, pattern, or arbitrary JSON Schema semantics.
- Snapshot installation reconstructs runtime layout and connection-local views.
  That cost buys portability and keeps derived state disposable.

## Considered alternatives

- **Make the SQLite file portable.** Rejected because it mixes canonical data
  with runtime and replica state.
- **Persist application views in the main schema.** Rejected because two
  releases could write incompatible lens definitions into shared data.
- **Use generated columns.** Rejected because they mutate canonical physical
  schema for release-local interpretation.
- **Materialize TEMP tables.** Rejected because they add open cost and require
  invalidation and rebuild machinery.
- **Implement custom virtual tables.** Rejected because a saved SELECT already
  supplies the named read relation without module, cursor, and planner hooks.
- **Generate every SELECT at the call site.** Rejected because views provide the
  smallest named relation for arbitrary joins with no measurable abstraction
  cost.
