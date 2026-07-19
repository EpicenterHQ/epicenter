# 0144. Scalar rows and row documents synchronize through independent client planes

- **Status:** Proposed
- **Date:** 2026-07-17
- **Amends:** [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md), [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md)
- **Amended by:** [ADR-0156](0156-row-documents-persist-in-one-owner-side-sqlite-update-log.md) — the browser document owner is the records Worker's OPFS SQLite update log, not a page-side IndexedDB log; the independent-planes contract itself is unchanged.

## Context

Rows need bounded queryable scalar state, while rich collaborative content needs
lazy loading, CRDT merge, and a realtime provider ecosystem. It may later need
presence. Sending
both through one SQLite replica and one row-intent protocol makes document
durability, hydration, settlement, acquisition, and Worker ordering part of the
scalar synchronization state machine.

## Decision

A workspace exposes one row identity with two independent client planes:

```txt
scalar plane    JSON fields and KV in runtime-native SQLite
document plane  one lazy Yjs document persisted by a runtime-native provider
```

The public API remains subordinate to the row:

```ts
using document = await workspace.tables.notes.document.open(rowId);
```

The handle exposes application-owned Yjs roots, local `whenDurable()`, and
disposal. It does not expose provider ownership or a free-standing document
identity.

`RowIntent` contains scalar row or KV changes only. The scalar protocol keeps
its exact-retry receipts, fixed-head current-state feed, tombstones, automatic
acquisition, and optimistic open/sealed overlay. The server workspace authority
owns the durable scalar implementation alongside server document persistence as
defined by ADR-0145; independent client planes do not require independent server
transaction owners. `workspace.sync` reports and settles only the scalar plane.
A document has its own local durability barrier and reactive connection status;
it exposes no remote settlement barrier until a concrete workflow earns one.

The planes are remotely eventual, not atomic. A live row may be visible before
its document arrives. An offline-created document persists locally immediately
and connects after its row reaches the authority. Applications must not require
scalar fields and document roots to represent one exact remote transaction.

Browser scalar storage uses OPFS SQLite while browser document persistence uses
an IndexedDB update log. Native hosts use native SQLite for scalar rows and may
store document updates in private SQLite tables or files behind the document
provider. Sharing one physical file does not create a cross-plane transaction
promise.

## Consequences

- Arbitrary read-only SQL remains available over visible scalar rows without
  loading Yjs documents.
- Document hydration, reconnects, compaction, and any future presence leave the
  scalar replica state machine.
- The browser page owns lazy Yjs documents while the SQLite Worker owns scalar
  rows; document admission reservations no longer cross that boundary.
- Metadata-first loading and non-atomic export are explicit product behavior.
- A workflow needing one atomic scalar/document invariant must put that
  invariant inside the document or use an application-specific authority.
- Presence belongs to the document plane if a real cursor or co-presence
  consumer earns it. The first document major does not ship speculative
  awareness frames or cleanup semantics.

## Considered alternatives

- **Keep document updates in `RowIntent`.** Rejected because it preserves one
  coupled durability, acquisition, and settlement protocol.
- **Put every scalar row in one Yjs document.** Rejected because large row sets
  would need to hydrate into memory and would lose the direct SQLite query
  surface.
- **Make documents top-level resources.** Rejected because the row remains the
  public identity and lifecycle aggregate.
