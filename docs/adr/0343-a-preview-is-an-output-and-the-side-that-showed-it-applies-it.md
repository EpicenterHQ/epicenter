# 0343. Change inspection compares files with their baseline

- **Status:** Proposed
- **Date:** 2026-09-21
- **Relates:** [ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md) defines file-versus-baseline Push; [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) establishes the readable working copy.
- **Unbuilt:** The revised baseline and inspection behavior. Current checkout still uses live-store previews, confirmation callbacks, and partial-result bookkeeping.

## Context

The earlier proposal encoded the three-way checkout workflow in library APIs.
The settled model submits file differences through ordinary store edits.

## Decision

The working-copy engine computes one file-versus-baseline change set for
inspection and application. It does not render the current store to explain
which remote values Push would overwrite. ADR-0418 defines the edits.

A UI or CLI can display file changes without a library-owned confirmation loop.
Inspection is not an executable plan that remains valid indefinitely. Applying
edits must read a coherent set of files and must not mark later external edits
as submitted. Folder operation exclusion and protection against overwriting
concurrent file changes remain necessary.

The earlier mandatory `confirm` callback, repeated remote-preview comparison,
and claim that a diagnostic diff is forbidden are withdrawn. The host owns
interaction and authorization. This does not by itself authorize an agent to
Push or settle which process owns the replica and filesystem.

An HTTP ETag is one transport's folder fingerprint. It is not a universal
working-copy API requirement. Removing that transport requires a concrete
replacement owner and must preserve filesystem race protection.

## Consequences

Keep one baseline and one editing path. Current implementations are evidence
of the old behavior, not instructions to retain its API or failure states.

## Considered alternatives

- Preserve the earlier workflow as a mode: retains the duplicate comparison
  and lifecycle machinery that the new invariant removes.
