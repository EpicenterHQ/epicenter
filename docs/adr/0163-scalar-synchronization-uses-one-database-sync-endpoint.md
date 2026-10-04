# 0163. Scalar synchronization uses one database sync endpoint

- **Status:** Proposed
- **Date:** 2026-07-20
- **Relates:** [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md), [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md)

## Context

Scalar synchronization currently exposes three POST routes below
`/workspaces/:workspaceId/records`. Push, pull, and acquisition share principal
resolution, database resolution, request limits, protocol negotiation, and
error handling. Their request bodies are already a discriminated protocol
union; only first-contact push adds an admission decision.

## Decision

The network exposes one scalar endpoint:

```txt
POST /api/databases/:databaseId/sync
```

The request and response remain discriminated by `kind: 'push' | 'pull' |
'acquire'`. `push` submits one immutable local intent round, `pull` reads the
incremental change interval after a checkpoint, and `acquire` reads an anchored
full-state page for bootstrap or recovery beyond retained history. These are
protocol operations, not public `Database` methods or URL resources.

The route parses the union once, resolves one authority, and dispatches to
separate owner methods. First-contact admission remains inside the push branch.
Row-document WebSockets stay on their independent row-addressed route and
protocol.

## Consequences

- Authentication, size limits, protocol mismatch handling, and authority
  lookup have one HTTP boundary.
- Adding a protocol operation changes the discriminated codec and dispatcher,
  not the route graph.
- Internal `push`, `pull`, and `acquire` methods remain separately testable and
  retain their precise convergence meanings.
- Old workspace and records URLs disappear without redirects.

## Considered alternatives

- **Keep three `/rows/{operation}` routes.** Rejected because the path split
  duplicates one transport boundary without creating three independently
  cacheable, authorizable, or addressable resources.
- **Rename acquire to snapshot.** Rejected because acquisition is an anchored,
  paged recovery protocol, not a portable snapshot artifact.

