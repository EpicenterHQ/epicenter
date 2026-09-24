# 0434. Capture keeps unavailable thoughts visible

- **Status:** Proposed
- **Date:** 2026-09-23
- **Implementation:** One-level thought moves and ordering, unavailable-capture recovery, and confirmed deletion over `captures` and `thoughts` are implemented in the current checkout. Markdown handoff remains later work.

## Context

[ADR-0432](0432-captures-hold-ordered-thoughts-beneath-a-dated-timeline.md) gives each thought one `captureId`. A local operation can validate that the destination capture exists. Offline replicas can still disagree about that existence: one device may delete a capture while another adds or moves a thought into it. The store merges their rows without enforcing cross-table referential integrity.

The current recursive entry forest makes a child of a missing parent visible at the root. Removing recursion must not quietly turn surviving writing into an invisible row.

## Decision

**Every readable surviving thought remains reachable even when its capture is unavailable.** Normal thought lists select rows whose `captureId` names that capture and sort them by stored position, then ID. Thoughts whose capture cannot currently be read appear in a visible recovery group. Keep their original `captureId` so a parent that arrives later through synchronization restores the ordinary placement without a repair write. The person can read, edit, copy, move, or explicitly delete a thought in recovery. Capture does not create a replacement parent or silently change membership while reading.

Moving a thought validates a readable destination capture, then updates its `captureId` and its position among that capture's thoughts. A thought cannot become a parent. Reordering changes positions while preserving IDs and bodies. Concurrent reorders may choose a different final order from either device's full local arrangement; a deterministic ID tie-breaker keeps every thought visible. No server coordinator or persisted conflict flag is required for this first release.

Deleting a thought removes only that thought after confirmation. Deleting a capture previews its editable text and the exact thought IDs and text currently selected on that device. Refresh the preview if locally visible membership or content changes before confirmation. Unreadable thought rows whose membership cannot be determined block a claim that the preview is complete. Delete only the confirmed IDs in one synchronous store transaction and wait for local persistence before reporting success. An overlapping deletion is idempotent.

A thought added or moved into the capture on an offline device after the preview may survive. When it synchronizes after the capture is gone, it appears in recovery. There is no later cascade or cleanup sweep. Confirmation explains that already selected thoughts are deleted even if another device concurrently moves them away. Copying to Markdown never initiates deletion; a separate deletion action uses a fresh preview.

## Consequences

The one-level invariant removes ancestor validation, cycle cuts, recursive breadcrumbs, and subtree-preserving moves. The remaining recovery group is necessary because two tables alone do not guarantee a live parent under offline edits and deletion. It occasionally asks the person to choose a new context for surviving writing, but never requires them to notice an invisible orphan.

Deleting Capture rows and bodies does not promise immediate erasure of historical server bytes, backups, or exported copies. The store's field reference marks the target table; the product operation and recovery view own relationship behavior.

## Considered alternatives

- **Delete every future thought with a missing parent:** Can erase writing a person never reviewed or confirmed.
- **Hide missing-parent thoughts:** Preserves bytes but makes the writing unreachable in the product.
- **Automatically reattach to a new capture:** Invents context for a thought and writes on a read or sync event.
- **Put thoughts inside the capture document:** Makes parent deletion erase concurrent unseen thoughts and requires a structured body editor.
- **Retain recursive forest resolution:** Handles arbitrary nesting and cycles that the one-level product no longer offers.
