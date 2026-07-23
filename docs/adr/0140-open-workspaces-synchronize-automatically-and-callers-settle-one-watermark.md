# 0140. Open workspaces synchronize automatically and callers settle one watermark

- **Status:** Superseded by [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md)
- **Date:** 2026-07-17

## Context

Local writes already trigger background synchronization, but the workspace has
no coherent application-facing synchronization lifecycle. The current
`synchronize()` promise drains toward global quiescence, which can move forever
while local or remote edits continue, and terminal protocol conditions collapse
into generic background errors.

## Decision

An open synchronized workspace owns one background synchronization supervisor.
It reacts to local commits and runtime connectivity signals, coalesces concurrent
wakeups, retries transient transport failures, and exposes one observable status:
`caught-up`, `syncing`, `pending`, `recovery-required`, or `upgrade-required`.

`whenDurable()` remains the local SQLite barrier. It says nothing about authority
acceptance.

The optional `sync.settle()` barrier captures one fixed invocation-time cut. It
resolves as caught up only after every local intent present at invocation has
reached the authority and the client has installed authority state through the
watermark observed after that acceptance. Later edits remain eligible for the
supervisor but do not extend the caller's cut. Classified transport interruption
or a refused new storage enrollment returns pending while the supervisor retains
retry ownership. Pending reasons distinguish offline, retrying, authentication,
and storage limit. A safety halt returns recovery required. An incompatible
deployed protocol returns upgrade required while local reading, editing, and
durability continue. Programming, local storage, and same-version protocol
defects remain errors rather than ordinary sync status.

After a lineage safety halt, `sync.captureRecovery()` returns the workspace's
visible logical rows, row documents, and KV as a reviewable copy. Before a halt
it returns `null`. Capturing performs no network request and does not reset,
enroll, upload, import, or delete anything.

After the application preserves that copy, `sync.startFresh()` discards only
the halted Account replica's ambiguous private sync state, enrolls a new
lineage, and resolves after its first complete authority state is installed.
Device data is outside this operation. The application recreates any selected
recovery records through ordinary application commands after the fresh state is
available; recovery never silently reapplies the entire stale copy.

The replica assigns every changed local admission a monotonic local sequence. A
document update reserves its sequence synchronously when Yjs emits it, before
its asynchronous SQLite persistence begins. A new open intent records its birth
sequence and preserves it while later same-address edits compact into that
intent. In one invocation-time call stack, `settle()` captures both the fixed
document-durability barriers already visible in memory and the current admission
head. It awaits those barriers before asking the supervisor to settle the
captured head. Round selection then prioritizes every intent whose birth
sequence is at or below the cut. A later admission may compact into one of those
intents before it seals, but its higher sequence does not add another obligation
to the older caller. Once sealed, later edits enter a new open intent as usual.
An invocation-time desired effect that is superseded locally before sealing
counts as resolved. The local sequence is private scheduling metadata, not
authorship, conflict order, or wire identity.

Applications never coordinate public push and pull operations.

## Consequences

- Local editing never waits for network progress.
- Continuous editing cannot keep an older `settle()` call alive forever.
- One open and one sealed intent generation remain sufficient; the local
  admission watermark avoids a third settling generation.
- Apps can distinguish local durability, account settlement, ordinary offline
  delay, a safety halt, and a required app upgrade.
- A safety halt has one concrete escape artifact without teaching applications
  replica protocol state.
- A safety halt has one explicit destructive escape action instead of requiring
  private SQLite or OPFS surgery.
- Background scheduling and retry policy belong to the workspace runtime, not
  each application.
- `caught-up` is relative to a fixed watermark, not a claim that no future work
  can exist.

## Considered alternatives

- **Drain until nothing is changing.** Rejected because the target moves under
  continuous local or remote edits.
- **Give each call an arbitrary page or round budget.** Rejected because the
  budget has no product meaning.
- **Expose push and pull to applications.** Rejected because it gives protocol
  lifecycle ownership to every caller.
