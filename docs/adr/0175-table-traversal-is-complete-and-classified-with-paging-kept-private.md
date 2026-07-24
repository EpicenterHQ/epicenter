# 0175. Table traversal is complete and classified, with paging kept private

- **Status:** Accepted
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0001](0001-classified-scan-read-surface.md)
- **Amends:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md)
- **Amended by:** [ADR-0176](0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md)
  (withdraws the unowned Lens-declared-index possibility; the table traversal
  decision stands)
- **Relates:** [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md)

## Context

Every production table read currently traverses the complete table. A public
page API would make those callers write cursor loops, choose arbitrary limits,
and risk silently stopping after one page. Public equality filters and field
ordering would also imply a general query engine over unindexed JSON even
though no current application needs that contract.

## Decision

A typed table exposes one complete classified traversal through two consumption
forms. `entries()` is an
`AsyncIterable<Result<Row, NonconformingRowError>>` for incremental processing.
`scan()` consumes that traversal to completion and groups it as
`{ rows, nonconforming }`; it is not a second read law. Both forms visit live
rows in ascending row ID order.

The runtime may fetch bounded internal batches. Batch size, continuation
tokens, and batch boundaries remain private implementation details. The public
table surface exposes no `list`, `page`, `pages`, `limit`, cursor, equality
predicate, or arbitrary ordering option.

Traversal observes continuing live state, not a snapshot. A row that remains
live throughout traversal appears exactly once. Concurrent insertion or
deletion may affect whether a row appears. Callers that need a fixed cut must
not infer one from traversal continuation. A fixed cut would require a
separately owned snapshot facility; this traversal provides none.

Classification uses the existing `Result` vocabulary. A successful entry is a
typed row. A failed entry carries the nonconforming row diagnostic and its raw
JSON. There is no parallel `conforms` boolean and no raw conforming-row shape.
`Nonconforming` names the relationship between one preserved canonical row and
the current release-local Lens. It does not claim that the canonical JSON is
globally invalid, malformed, or corrupt.

Classification failure is row data, but operational failure is control flow.
A storage or transport failure throws from `entries()` or rejects `scan()`; it
is never fabricated as a nonconforming row.

## Consequences

- Ordinary callers consume the classified traversal to completion without
  writing a paging loop or accidentally dropping later rows.
- Large exports and repairs can process one entry at a time while the runtime
  bounds each storage and transport request.
- `entries()` bounds repair traversal only. Repair idempotency, observability,
  interruption, and concurrent-write policy remain application
  responsibilities under ADR-0125. Traversal supplies no snapshot, checkpoint,
  compare-and-set, revision check, or write precondition.
- `scan` and `entries` name traversal behavior rather than query expressivity.
  They remain accurate if the physical store or internal batch size changes.
- Application-specific sorting and filtering happen after typed traversal.
  Epicenter does not pretend unindexed JSON predicates are cheap or stable.
- A future pure JSON Lens may declare named indexes. A concrete caller may then
  earn an index-scoped filtering, ordering, or manual-page surface. This ADR
  leaves that design open and does not promise arbitrary field queries.
- This application table API does not expose relational inspection. The
  separately proposed ADR-0162 addresses Epicenter Home's trusted inspection
  capability.

## Considered alternatives

- **One public `list` with cursor, limit, filter, and order.** Rejected because
  every current caller wants the complete traversal, while the larger surface
  creates truncation bugs and promises unindexed query behavior.
- **Public `pages()`.** Rejected because callers do not need to observe or tune
  page boundaries. `entries()` already permits bounded incremental work.
- **`inspect()` for nonconforming rows.** Rejected because inspection names the
  trusted Home workflow and suggests diagnostics rather than an ordinary typed
  read.
- **Separate valid-only and repair scans.** Rejected because a valid-only
  default silently hides canonical data. Both consumption forms classify every
  visited row.
- **Call rows `invalid`, `malformed`, or `rejected`.** Rejected because the
  authority honestly preserves schema-opaque JSON. Projection fails relative
  to one Lens; the stored data does not fail a global schema or admission law.
- **Drizzle or another ORM query builder.** Rejected for application tables
  because it exposes relational expressivity over a private physical store.
  The proposed ADR-0162 considers ad hoc inspection as a separate trusted Home
  capability.
