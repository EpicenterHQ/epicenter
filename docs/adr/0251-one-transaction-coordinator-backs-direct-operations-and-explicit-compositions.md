# 0251. One transaction coordinator backs direct operations and explicit compositions

- **Status:** Accepted
- **Date:** 2026-08-19
  open ADRs before merge.
- **Amends:** ADR-0250
  at the transaction entry surface. Withdrawn: requiring callers to wrap every
  one-operation mutation, and flattening transaction tables into names such as
  `tx.pages`.
- **Relates:** [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md)
  and [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md).
- **Amended by:** [ADR-0253](0253-schema-lenses-interpret-stored-json-on-read-and-writes-admit-storage-valid-facts.md) at write result channels. Schema failures are not write errors; structural and lifecycle outcomes remain.
- **Unbuilt:** `db.transact`, its transaction-scoped database view, and direct
  operation methods that delegate to the same coordinator.

## Context

One-off scalar writes should be easy to call, while page actions need an
explicit place to compose a row mutation with document lifecycle operations.
Those are two entry styles for the same local durability mechanism, not two
transaction models. A transaction context also needs to preserve the database's
declared namespace instead of inventing a second vocabulary for tables.

## Decision

**Every database-level mutation runs through one transaction coordinator.
Direct operations are its one-operation shorthand; explicit composition uses
`db.transact` with a transaction-scoped view that mirrors the database
namespace.**

The public shapes are:

```ts
// One scalar operation. It still uses the coordinator internally.
db.tables.pages.delete(pageId);

// Several operations composed into one local durable batch.
db.transact((tx) => {
	const deleted = tx.tables.pages.delete(pageId);
	if (deleted) tx.documents.retire(documentAddress(...));
	return deleted;
});
```

The direct operation is equivalent to one transaction containing that
operation:

```ts
db.tables.pages.delete(pageId);
// is the ergonomic form of:
db.transact((tx) => tx.tables.pages.delete(pageId));
```

The transaction view mirrors the database view: `tx.tables`, `tx.kv`, and
`tx.documents`. Transaction-scoped methods perform their work inside the
active transaction and do not start nested transactions. There is no generic
`db.tables.delete` because `tables` is a namespace, and there is no flattened
`tx.pages` because pages are members of the declared `tables` namespace.

`db.transact` is a database-store coordinator, not a cross-document Yjs
transaction. A rich document handle continues to edit its independent Yjs
document through that document's own transaction and persistence listener. The
database coordinator composes scalar mutations and lifecycle facts into one
local durable batch; it promises neither cross-Y.Doc rollback nor atomic remote
visibility.

## Consequences

- `db.tables.pages.delete(id)` remains a useful scalar primitive and does not
  implicitly retire a document. A document-owning application action uses
  `db.transact` when its policy requires retirement.
- One-off calls and composed actions share one implementation, one durability
  boundary, and one notification policy.
- The transaction API is predictable for every database shape because it
  mirrors the normal namespace instead of introducing transaction-only names.
- Document-content edits do not gain a false promise of atomicity with scalar
  edits. They remain independent Yjs operations carried by the same database
  runtime and optional sync connection.

## Considered alternatives

- **Require `db.transact` around every mutation:** refused because it adds
  ceremony without adding composition semantics for a one-operation write.
- **Let direct methods bypass transactions:** refused because acceptance,
  local durability, and notifications would then have multiple owners.
- **Expose `tx.pages` beside `db.tables.pages`:** refused because the
  transaction view would no longer mirror the database and would need a second
  naming rule for every future namespace.
- **Run document-handle edits inside `db.transact`:** refused because
  independent Yjs documents cannot acquire cross-document rollback or remote
  atomic visibility from a local callback.
