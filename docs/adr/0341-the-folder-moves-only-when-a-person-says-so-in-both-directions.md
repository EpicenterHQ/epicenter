# 0341. The working-copy baseline advances with durable edits

- **Status:** Proposed
- **Date:** 2026-09-21
- **Relates:** [ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md) defines file-versus-baseline Push; [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) establishes the readable working copy.
- **Unbuilt:** The revised baseline and inspection behavior. Current checkout still uses live-store previews, confirmation callbacks, and partial-result bookkeeping.

## Context

The earlier proposal encoded the three-way checkout workflow in library APIs.
The settled model submits file differences through ordinary store edits.

## Decision

Pull materializes the replica and records exactly what it wrote. Push computes
file differences as specified by ADR-0418 and advances the baseline only for
edits durably recorded in the local replica. Remote delivery uses the outbox.

Push must not absorb unseen file changes or newly received remote values into
the baseline. A baseline is evidence of materialization or submission, not a
cache of the latest store state. Push updates baseline metadata only; authored files remain untouched.

File writes and replica persistence are separate failure boundaries. ADR-0418
requires durable unfinished-operation evidence before mutation, then completed
baseline advancement only after durable success. An uncertain outcome blocks
normal Pull/Push and requires explicit reconciliation after the old operation
has settled. There is no automatic replay or owner-held submission receipt.
Validate interruption handling before publishing success guarantees.

This replaces the earlier draft's partial-application and automatic
resurrection prescriptions. ADR-0418 owns dirty-Pull refusal and the receiving
owner's missing-row checks.

## Consequences

Keep one baseline and one editing path. Current implementations are evidence
of the old behavior, not instructions to retain its API or failure states.

## Considered alternatives

- Preserve the earlier workflow as a mode: retains the duplicate comparison
  and lifecycle machinery that the new invariant removes.
