# 0650. A browser's current folder is one immutable tree

- **Status:** Proposed
- **Date:** 2026-10-20
- **Amends:** [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) at the persisted edit overlay, revision-based publication, and hidden edit intent between identical snapshots. Its merge units, ordinary Git exchange, snapshot retention, and absence of a cross-tab owner remain.
- **Relates:** [ADR-0636](0636-an-app-opens-local-files-through-one-folder-handle.md) keeps storage and Git details outside the app-facing Folder contract.
- **Unbuilt:** automatic public sync integration and scheduling, hosted-service verification, and phone/eviction/termination evidence. Production working-tree storage and local native-server synchronization have desktop browser evidence.

## Context

The current browser derives its saved folder from a commit and an overlay of
text and deletion markers. That requires shadowing, prefix tombstones, and
normalization against the committed snapshot. Sync separately keeps the last
incorporated remote commit and one exact pending commit whose outcome may be
unknown. Later saves must survive acknowledgement or rejection of that commit.

The owner chose a current working tree after comparing explanations, accepts
the measured desktop speed tradeoff, and authorized a clean break with zero
users and no migrations. The
[prototype evidence](../../packages/folder/evidence/browser-engine/working-tree-prototype/RESULTS.md)
shows faster large-backlog operations and slower small-backlog saves in wide
directories. A type index reduces collection costs without a reference ledger.

## Decision

**The saved folder is one immutable Git tree.** Its root identifies current
file contents independently of either sync checkpoint. Saving stores a new
blob and changed ancestor trees, then atomically publishes the root. It creates
no commit. Deleting removes an entry. Equal contents have equal roots.
Initialization establishes a valid empty tree, so the working root is never
missing. The browser stores shared objects, not durable diffs.

**Keep both sync checkpoints explicit.** The last incorporated remote commit
and the exact pending commit remain separate references. Unknown remote state
differs from an observed empty remote. All three snapshots share unchanged
objects. Deriving the remote base from a pending commit's parent would save a
pointer while adding conditional decoding and retention rules.

**Immutable inputs guard publication.** A file save compares its captured
working root inside the write transaction and preserves current sync metadata.
Reconciliation and preparation compare all three references. Acknowledgement
checks the exact remote and pending pair and preserves the latest working root.
Collection does not change roots. A separate publication revision is unnecessary
with all writers using this representation in a fresh database namespace.

**Equal snapshots carry equal change intent.** Canceling a folder replacement
and restoring the identical tree leaves no hidden prefix deletion. In the
current overlay, a surviving prefix tombstone can cause a recreated file to
overwrite an independent remote field even though the visible tree equals the
pending snapshot. Under snapshot semantics, the independent remote field survives.
This is an observable merge-policy change. Newer reversals across an actual
pending checkpoint still matter because the working and pending trees differ;
retain two-generation reconciliation on proven rejection.

**Storage owns collection of snapshot closures.** Retain the working tree and
both checkpoint snapshots, stopping at commit parents. A conservative persisted
retirement budget schedules collection; it is not an exact garbage count.
IndexedDB's object-type index avoids reading live blob bytes during marking.
Liveness and deletion share one transaction. A maintenance failure after a
successful publication cannot turn that save into a reported failure.

The public Folder contract exposes none of these roots, collection controls,
or commit operations. Rows remain views of files. Diffs, traversal sets, and
captured object maps are temporary computation, not additional durable models.

## Consequences

- Two object stores hold one object pool and one metadata record. The edit
  store, prefix markers, overlay normalization, and publication counter go away.
- Saves hash contents and rewrite ancestor directories. Wide directories and
  repeated large-file overwrites can be slower; accumulated offline edits no
  longer make each read capture every saved edit value.
- Replaced objects consume space until collection. Collection pauses and
  transaction queueing remain costs; the budget does not cap physical usage.
- Commit preparation starts with an existing tree. Network latency and peak
  memory still need representative measurements; desktop regressions establish
  the covered reconciliation cases.
- Production checks in Chromium, WebKit, and Firefox validate concurrent saves,
  collection, exact acknowledgement, native Git exchange, lost replies, and
  graceful full-profile reopening.
- The database is a fresh two-store layout. No migration, legacy reader, or
  compatibility runtime preserves earlier IndexedDB data. Older storage is
  ignored; there are no users to convert.

The [browser README](../../packages/folder/src/browser/README.md) describes the
implementation. [Recorded evidence and the complete flow review](../../packages/folder/evidence/browser-engine/working-tree/RESULTS.md)
cover the hidden-deletion regression, retained lifecycle responsibilities, and
remaining costs.

## Considered alternatives

- **Keep the overlay and narrow its reads.** Could improve current latency,
  but retains a second representation and its shadowing rules.
- **Persist file diffs, path indexes, or reference counts.** Adds durable
  bookkeeping with normalization and recovery obligations.
- **Keep only the current folder and remote base.** Loses the exact uncertain
  send and cannot separate its fate from later saves.
- **Collapse rejected-pending reconciliation to one merge.** Can erase a newer
  reversal or resurrect a rejected contribution. The representation change
  alone does not justify that policy change.
