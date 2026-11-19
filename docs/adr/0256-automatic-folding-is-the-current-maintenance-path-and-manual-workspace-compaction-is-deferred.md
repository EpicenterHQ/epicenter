# 0256. Automatic folding is the current maintenance path, and manual workspace compaction is deferred

- **Status:** Accepted
- **Date:** 2026-08-20
- **Supersedes:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) at the product rebuild action and the authority's whole-document replacement path
- **Amended by:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) at the deferred whole-document rebuild, which is now available as Rebuild workspace: it creates a generation from the client's own live document under a compare-and-swap lease, and the authority never proves coverage because nothing is replaced.
- **Amended by:** [ADR-0267](0267-a-workspace-exports-and-imports-as-a-legible-folder-structured-artifact.md) at the deferred Compact-workspace action: the manual reset is no longer deferred, it is export and import.
- **Relates:** ADR-0220, ADR-0233, and [ADR-0255](0255-data-definitions-use-one-data-first-public-vocabulary.md)

## Context

The repository measured two different kinds of storage pressure. Ordinary
local update logs fold automatically, and the authority folds acknowledged
history into a snapshot and tail. Repeated edits to one scalar and normal
rich-text edits stay small after those folds. Distributed root-row churn and
deletions retain more Yjs structs, but current workloads do not justify a
lossy, user-visible whole-document rewrite.

ADR-0231 introduced a product-facing rebuild action, a client-side Yjs copy
walk, a replacement HTTP route, and a privileged authority mutation. That
family adds a second lifecycle and a data-loss boundary before a product has
measured a need for it.

## Decision

Automatic local update-log folding and authority snapshot folding are the only
maintenance paths exposed today. The product has no Rebuild workspace action,
no Compact workspace action, no public generation API, and no whole-document
replacement route.

The sync protocol still carries an opaque document identity. A replica whose
declared identity does not equal the authority's identity is superseded and
must discard its physical replica before rejoining. That identity gate remains
sync correctness; it is not a public replacement workflow.

If measured root-document pressure later becomes user-facing, a new decision
may introduce **Compact workspace**. It must be an explicit application-owned
action with a visible loss boundary for unsynchronized work, a stable logical
address, a private replacement identity, and an atomic compare-and-swap against
the identity and head the compacted value covered. The future design must be
written from the measured pressure and may choose a different authority
protocol; the deleted replacement route is not a reserved seam.

## Consequences

- A person cannot accidentally trigger a destructive whole-document rewrite.
- The current API has one storage-maintenance story: automatic folding.
- `pressure()` remains instrumentation for deciding whether a future Compact
  workspace action has earned its place; it is not a button or a promise.
- The authority remains blind to application meaning and only folds snapshots
  when the existing coverage and delivery proofs hold.
- Git preserves the withdrawn rebuild implementation and its evidence without
  making them part of the runtime or public package surface.

## Considered alternatives

- **Keep the dormant replacement route.** Rejected because it preserves a
  high-impact destructive write with no live producer and would prejudge the
  future compact protocol.
- **Run compaction automatically.** Rejected because the operation can discard
  unsynchronized offline work and the current measurements do not justify that
  loss boundary.
- **Expose generations or rebase old replicas.** Rejected because they add
  identity, retention, and migration machinery before a concrete product need.
