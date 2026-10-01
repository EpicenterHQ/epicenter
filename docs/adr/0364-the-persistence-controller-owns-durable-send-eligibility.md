# 0364. The persistence controller owns durable send eligibility

- **Status:** Proposed
- **Date:** 2026-09-08

## Context

The store allocated update IDs and chose owed rows to merge while its persistence
controller separately tracked queued and confirmed operations. A local edit
nudged sync before its append completed. Slow storage could outlast that nudge
and leave durable work unsent. An acknowledgement waiting on storage could be
selected for immediate resend. Repeated edits could queue several replacements
for the same still-confirmed rows.

The controller also had separate synchronous and asynchronous completion paths.
Those paths made the timing of mirror updates, notifications, and debt maintenance
depend on the adapter. Tests over SQLite could miss races in browser persistence.

## Decision

**The persistence controller owns the transition from accepted updates to durable,
sendable work.**

`packages/app/src/data/store/persistence.ts` allocates monotone IDs, queues appends and
acknowledgements, mirrors confirmed rows, merges unsubmitted owed rows, and wakes
sync through `onSendable` after a successful commit. The store owns the live
`Y.Doc` and supplies authored or received bytes to that controller.

Every adapter follows one asynchronous drain. Native SQLite transactions remain
synchronous inside the port. `persistence.flush()` waits for the requested drain;
its status reports success or retained failure. Drain ownership ends in the same
continuation as the final batch, so an edit arriving in the next microtask starts
another drain instead of joining an already-finished one.

A received acknowledgement suppresses resend in the current session immediately.
Its cursor and durable retirement still wait for storage. If the process dies
first, reopening reconstructs the owed rows and resends them. Debt replacement
runs from confirmed rows after queued work finishes and assigns a fresh ID above
every existing ID. An older acknowledgement therefore cannot retire new bytes.

The durable record stays unchanged: update bytes, a monotone local ID, and a
nullable authority position. `append`, `ack`, and `mergeOwed` retain their distinct
meanings. Each port commits the entire batch or rolls it back, including when
JavaScript compaction code throws inside an IndexedDB transaction.

## Consequences

The store no longer maintains a second ID allocator, submission watermark, or
debt-fold scheduler. The controller no longer exposes raw operation enqueueing
and its durable outbox solely for tests. Its completion logic has one path.

Local edits remain visible immediately. Direct SQLite replica callers now await
`openAccountStore`, and every store backing follows acquisition, hydration, and
listener installation before readiness. A synchronous replica write no longer
promises confirmed durability on return. Callers that need durability await
`persistence.flush()` and inspect its status.

A failed append prevents sending those bytes until storage recovers. This accepts
possible loss on a blocked close. It also ensures a sender cannot acknowledge
work that its local durable record cannot reconstruct.

Regression tests cover delayed completion beyond the send window, pending
acknowledgement recovery, a burst during debt replacement, the completion
microtask race, and failed-fold rollback against SQLite and IndexedDB.

## Considered alternatives

- Keep ID allocation and merging in the store: duplicates knowledge of confirmed
  and pending rows across two owners.
- Keep synchronous replica completion: gives tests a second timing contract and
  preserves branching without a production browser caller that benefits.
- Replace the log with one snapshot: a snapshot alone cannot express which
  bytes still need acknowledgement; replacing it per edit also writes the whole
  document.
- Remove the cursor using state vectors: state vectors describe CRDT structure
  progress, not acknowledgement by a byte-blind log, and do not by themselves
  identify deletion-only differences.
- Remove origin handling: received updates may emit no update event while Yjs
  waits for dependencies, so persistence must retain the received bytes. The
  local marker also distinguishes store rewrites from editor undo history.
