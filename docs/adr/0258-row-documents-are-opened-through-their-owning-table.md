# 0258. Row documents are opened through their owning table

- **Status:** Accepted
- **Date:** 2026-08-21
  open ADRs before merge.
- **Supersedes:** ADR-0250
  at the public document namespace and lifecycle owner. The independent
  document, derived address, and opaque manager remain.
- **Amends:** [ADR-0255](0255-data-definitions-use-one-data-first-public-vocabulary.md)
  at the opened data surface: `data.tables` owns row-document opening, and
  `data.documents` is not public.
- **Relates to:** ADR-0248
  and [ADR-0251](0251-one-transaction-coordinator-backs-direct-operations-and-explicit-compositions.md).

## Context

Each row's rich content is an independent Yjs document at a derived opaque
address. The document manager owns hydration, reuse, persistence, retirement,
and disposal, but it cannot decide whether a table row exists or whether a
document belongs to that row. The repository's real callers all open row
documents through typed table handles; the raw address opener had no production
caller and exposed an address format that the table layer owns.

## Decision

**The table is the public owner of a row document.** Applications open one with
`data.tables.notes.openDocument(rowId)`. The table checks row liveness, derives
the opaque address, and delegates to the package-private document manager. The
manager remains a reusable internal lifecycle engine and is not exposed on
`data` or `data.store`.

Row deletion continues to compose scalar removal with document retirement in
one durable batch. A deleted row therefore cannot be reopened through the
public API, and a late remote update cannot resurrect its document.

The public package exports `RowDocumentHandle` and `DocumentError`, because
callers receive and handle those values. It does not export `DocumentManager`
or an address-level `open(address)` capability.

## Consequences

- Callers do not construct or persist document addresses.
- The common row-document path has one owner and one obvious call site:
  `await data.tables.notes.openDocument(rowId)`.
- The generic manager remains independently testable and reusable for the
  store's internal remote and persistence paths.
- A future non-row document gets an owner-specific public capability when its
  lifecycle exists; the raw manager does not become a general escape hatch.
- An application cannot use the public API to share one document across rows
  or retain a document after deleting its row. That policy must be earned by a
  separate domain owner and decision.

## Considered alternatives

- **Expose `data.documents.open(address)`:** refused because it leaks the
  address grammar and bypasses the table's row-liveness and retirement rules.
- **Make the manager understand tables and rows:** refused because it moves
  schema and lifecycle policy into the generic document engine.
- **Keep `table.document.open(rowId)`:** refused because a namespace with one
  public member adds indirection without owning a second document operation.
