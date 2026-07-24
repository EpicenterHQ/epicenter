# 0176. Lenses declare no query capabilities; indexed reads require separate owners

- **Status:** Accepted
- **Date:** 2026-07-21
- **Amends:** [ADR-0175](0175-table-traversal-is-complete-and-classified-with-paging-kept-private.md) by withdrawing its unowned Lens-declared-index possibility
- **Relates:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md)

## Context

ADR-0175 left open the possibility that a pure JSON Lens might declare named
indexes. ADR-0125 establishes Lenses as partial, overlapping, and release-local.
Assigning an index to one would leave installation, rebuilding, eviction,
resource limits, and conflicting declarations without an accepted owner.
ADR-0122 already requires derived indexes to remain independently disposable
runtime state.

## Decision

Lenses currently declare no indexes, predicates, ordering, query projections,
or query capabilities. `get`, `entries`, and `scan` remain the complete typed
application read surface.

A future index-backed application read requires a separate decision that
assigns two responsibilities explicitly:

1. the semantic owner that declares one measured access pattern; and
2. the runtime owner that materializes, rebuilds, limits, evicts, and disposes
   its physical index.

Only after both owners exist may an application API expose the filtering,
ordering, direction, or continuation that the declared access pattern can
honestly support. That surface must be index-scoped. It must not generalize into
arbitrary JSON predicates, field ordering, SQL, or an ORM over private storage.

## Consequences

- Pure JSON makes a Lens portable; it does not make the Lens a lifecycle owner
  or prove that an index belongs in its contract.
- No current caller can request a predicate, ordering, page, or cursor from a
  table or Lens.
- A measured future query may still earn a named semantic access pattern. Its
  physical representation remains disposable runtime state and never enters
  canonical data or synchronization.
- This decision leaves ad hoc relational inspection outside typed application
  reads. The proposed ADR-0162 assigns that separate capability to Epicenter
  Home.

## Considered alternatives

- **Declare indexes directly in each Lens now.** Rejected because overlapping
  release-local interpretations own no installation or disposal lifecycle.
- **Expose query syntax before assigning a physical owner.** Rejected because
  it promises performance and ordering semantics that no layer is responsible
  for maintaining.
- **Use Drizzle or SQL as the application query surface.** Rejected because it
  exposes private relational storage and duplicates Home's inspection role.
