# 0500. Svelte tracks native data reads without holding row values

- **Status:** Superseded
- **Date:** 2026-10-03
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Supersedes:** [ADR-0311](0311-a-table-is-a-held-projection-and-everything-cheaper-than-rebuilding-is-read-through.md), the adapter-held table projection.

## Context

The only current production caller of `fromData` is Local Mail's Saved Queries
panel. It needs current rows, repair diagnostics, writes, and persistence status.
It does not require incremental large-list rendering or per-row wake precision.

The held adapter interpreted rows separately from the native store. A committed
callback could read the new native row and an old reactive row because table
notifications arrived later. After disposal, native reads rejected access while
cached reads returned the last rows. Readability, diagnostics, and membership
needed separate collections and permanent maintenance between reader lifetimes.

## Decision

`fromData` registers Svelte dependencies and calls native table, KV, and
persistence methods. It holds no row values or diagnostics. Native reads own
validation, transaction visibility, body availability, and lifetime admission.

One subscription per table wakes its active readers on table commits. It
attaches on the first reactive reader and detaches after the last. Imperative
reads attach nothing. Body text edits keep their separate `watch` feed.

Inputs are native plain-object handles with closure-bound methods. Wrappers
preserve own descriptors and capability identities; they reject class instances
rather than claim to preserve prototype methods.

## Consequences

The three table collections, eager seed, reconciliation loop, and permanent
maintenance subscription disappear. Computed reads remain methods, with the
same row types and native write capabilities.

A table commit can rerun point and ID readers whose returned values did not
change. Full row reads repeat native validation. This is acceptable for the
current saved-query table. A future large-list caller must establish its cost
before introducing caching. A native cache would also need transaction-aware
invalidation and an explicit mutable or immutable snapshot contract.

Real Svelte effect tests cover tracking, detach/remount, malformed structure,
commit visibility, and closed-store rejection. Cache-bookkeeping tests no
longer describe a supported promise.

## Considered alternatives

Keeping held projections preserves incremental reads but retains a second read
model and its lifecycle and commit-order gaps. Moving a classification cache
into the native store could centralize interpretation, but snapshot ownership
and invalidation add machinery without a current large-list consumer.
