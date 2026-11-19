# 0300. Accepted edits are live immediately, and persistence and sync are best-effort

- **Status:** Accepted
- **Date:** 2026-08-31
- **Amends:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md) at the rule that sync sends only durably recorded work
- **Relates:** ADR-0298, [ADR-0110](0110-edit-write-timing-follows-the-value-owner-there-is-no-debounce-tier.md)
- **Amended by:** [ADR-0302](0302-a-local-edit-is-offered-to-the-authority-once-it-is-durable.md) at the transient sync-delivery queue, which is withdrawn. The rest stands: an edit is accepted live and neither path may throw through the editor.

## Context

An edit already changes the live Yjs document synchronously, which is the
state a person reads and sees. Requiring the editor to wait for local storage
before attempting sync makes a storage outage part of the typing path and
forces the persistence controller to own a cross-system guarantee it cannot
complete for an asynchronous browser store. The product accepts a smaller
failure boundary: an edit that has not reached either local durable storage or
the authority before the process ends may be lost.

## Decision

**Accept local edits immediately.** A local Yjs transaction updates the live
document and UI synchronously, then places its emitted bytes in two independent
best-effort paths: a local persistence attempt and a transient sync-delivery
queue. Sync may attempt delivery before local persistence succeeds. Neither
path may make acceptance depend on success or throw through the editor.

Local persistence retains failed work and exposes its health through the
existing persistence status. The sync queue retains work until the authority
acknowledges it while the process remains alive. A restart recovers only bytes
that reached local persistence; bytes acknowledged by the authority are safe to
re-download from the authority when the local cursor lagged.

The cursor remains a log position, not a durability or document-equality claim.
It advances in memory when delivery is observed and advances durably only when
the local record successfully commits. A lagging durable cursor replays an
already-applied entry, which is safe because Yjs updates are idempotent.

## Consequences

- Typing never depends on IndexedDB, SQLite, an acknowledgement, or a retry
  succeeding. Synchronous storage ports may perform their small append inline,
  but storage failure is still contained as persistence status.
- A storage failure is visible as persistence health, not as a failed edit.
- A network failure is visible as sync status, not as a failed edit.
- An edit can reach the authority before its local durable append. If the
  process then ends before local persistence succeeds, the authority restores
  that edit on the next connection; if neither path succeeded, the edit may be
  lost.
- The local update log remains useful for offline recovery and resend, but it
  is no longer a gate that decides whether an edit may be offered.
- No server-side Yjs hydration, state-vector acknowledgement, or semantic
  server merge is introduced. ADR-0298's byte-blind authority and positional
  cursor remain unchanged.

## Considered alternatives

- **Send only after local durability succeeds.** Rejected for the typing path:
  it couples live collaboration to a failing storage engine and turns a
  recoverable local persistence debt into delivery latency.
- **Throw when persistence fails.** Rejected: the live Yjs document is still
  valid, and the application can report and retry the durable debt without
  discarding the person's visible work.
- **Keep only a full binary and replace it on every edit.** Rejected because a
  byte-blind authority cannot merge concurrent whole-document replacements
  without accepting last-writer-wins loss.
