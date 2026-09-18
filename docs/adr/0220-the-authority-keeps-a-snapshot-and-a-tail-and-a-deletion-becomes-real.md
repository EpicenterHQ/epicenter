# 0220. The authority keeps a snapshot and a tail, and a deletion becomes real

- **Status:** Superseded
- **Superseded by:** [ADR-0277](0277-the-authority-reads-the-bytes-and-sync-becomes-the-yjs-protocol.md). A snapshot and a tail are what a server keeps when it cannot hold a document. A reading authority holds the document, and a deletion is real because the delete set travels with every diff.
- **Date:** 2026-08-08
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0217](0217-the-authority-appends-opaque-bytes-and-the-client-owns-every-merge.md)
  at its central refusal. Withdrawn: that the log is never compacted, that no
  party ever verifies another party's claim, and the whole *generations* section.
  What survives, unchanged, is that the authority holds opaque bytes, that the
  merge belongs to the client, that catch-up and live relay are one path, and
  that there is no state vector in the transport.
- **Amended by:** [ADR-0256](0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md)
  at scope only. This record's snapshot and tail are the retained state of one
  current document. No product action currently replaces that document; a
  future Compact workspace action would be a separate decision.
- **Relates:** [ADR-0218](0218-the-authority-reads-nothing-and-a-poison-entry-is-repaired-rather-than-prevented.md)
  (the authority reads nothing, which this preserves),
  [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (local persistence and history).
- Evidence: `packages/app/src/data/sync/transport.test.ts` (including a seeded
  convergence fuzz), `packages/app/evidence/data/retention.test.ts`,
  `packages/app/evidence/data/workerd/results.md`.

## Context

ADR-0217 refused compaction, because compaction must prove the replacement
covers what it replaces and that proof needs semantics the authority does not
have. Refusing it removed the requirement, and the price was quoted as storage:
about 4 MB a year against 10 GB.

That was not the price. An append-only log keeps the update that CREATED a row,
so deleting the row removes it from current state and removes nothing from the
log. Measured with a canary and a control: after a delete the text is still
recoverable from the authority's log, and **a device joining for the first time
downloads every note anyone has ever deleted** (`evidence/retention.test.ts`).
It then displays none of them, because the lens reads current state, so nothing
surfaces it.

The log also grew forever, so first sync grew forever. The current escape is
authority snapshot folding, which removes covered update entries but preserves
the current document's identity. A future root-document Compact action would
need its own identity, compare-and-swap, freezing, and loss-boundary decision;
it is deferred by ADR-0256.

## Decision

**The authority keeps one snapshot and the entries after it. Not a log.**

A replica offers its whole state as the snapshot for a position; everything the
snapshot covers is forgotten. First sync becomes state plus a short tail, and a
deletion becomes real, because a snapshot is current state and carries no trace
of what was deleted before it.

### Storage does not stop growing, and the first version of this record said it did

That claim was written without a measurement behind it, and it does not survive
one (`evidence/bench/flat-storage.ts`). Over 6,000 operations against a vault
holding a constant 300 live rows:

| | after 500 ops | after 6,000 ops |
| --- | --- | --- |
| snapshot and tail | 36 KB | **196 KB** |
| append-only log | 37 KB | 339 KB |

**A snapshot is current state, and current state carries the accumulated delete
set.** So the authority holds live rows plus roughly one tombstone per row ever
deleted. Storage tracks lifetime DELETIONS rather than the operation count,
which is a real improvement over a log and is not the same as flat. The gap
widens with time, 1.3x early and 1.7x late on this workload, which deletes on
every third operation and is therefore harsher than a real vault.

### And "a short tail" is wrong too, measured

The second quantitative claim in this record to fail a bench, and the same
species of failure as the first: the DIRECTION is right and the magnitude word
is not (`evidence/bench/first-sync.ts`). Over 240 days of use on the real
vault's shape, against an append-only control on the identical workload:

| history | snapshot and tail | append-only log |
| --- | --- | --- |
| 0 days | 2.7 MB, 14 entries | 2.7 MB, 25 entries |
| 60 days | 3.0 MB, 278 entries | 3.5 MB, 817 entries |
| 240 days | 5.4 MB, 2,654 entries | 5.8 MB, 3,193 entries |

The tail is a **sawtooth that decays back toward the log**, not a short
remainder. Just after a replacement a joiner pays 2.9x fewer entries and 64%
less time; six months later that is 17% fewer entries and 13% less time. Where a
new device lands on the tooth is luck.

The mechanism is also not what `authority.ts` says. `shouldSnapshot` compares
the tail against the SUM of retained snapshots, and two positions are retained
deliberately, so the number the tail must beat is about twice the live snapshot.
The trigger bounds the TAIL at roughly twice the state and the transfer at
roughly three times it.

So the honest claim is: **a joining device pays between one and three times the
vault, bounded, instead of paying all of history, unbounded.** That is a real
and worthwhile difference and it is not "a short tail".

Applying costs 2.3 to 2.8 ms per ENTRY, because each entry is one commit on the
arriving device, so the advantage is mostly in entry count rather than bytes:
the 60-day row transfers 14% fewer bytes and takes 64% less time.

What is genuinely bounded and unqualified: deleted CONTENT is gone at the next
snapshot.

### The condition is checkable without semantics, and it is two halves

This is compaction, which four designs failed at, and it works here only because
the precondition can be checked by counting rather than by understanding.

- **The authority checks coverage.** The offered position must lie inside the
  log and ahead of the snapshot already held.
- **The hub checks provenance.** The offer must come from a connection the
  authority has *sent* everything through that position. That is the authority's
  own record of what it transmitted, **not a claim the replica makes about
  itself**, and it is the entire difference between this and the client-posted
  baseline that an earlier design died on. Thirteen bytes of an empty document
  offered by a connection that has been sent nothing is refused, and the test
  that pins it uses exactly that payload.

### It is coverage, not currency

The first implementation required `position === head` and was wrong. An entry
landing between the request and the offer moved the head, and a perfectly good
snapshot was refused; under ordinary traffic that happened constantly. A
snapshot at P is only ever used to forget entries at or before P, so being
current was never the requirement.

### The trigger has one number in it

A snapshot is taken when the tail outgrows the snapshot, which bounds both
storage and any returning replica's download at about twice the state, and
needs no interval to tune.

**It also needs a floor, and pretending otherwise cost a live run.** The ratio
is scale-free, so on a small document the next update outgrows the snapshot
immediately; against Cloudflare it snapshotted on nearly every message and
stalled around the two hundredth. Below the floor the whole log is trivial and
replacing it buys nothing.

### Re-delivery is ordinary, and a gap is recoverable

Two rules the first implementation got backwards, both found by a seeded fuzz
over random schedules rather than by any written scenario.

**An entry already applied is not an error.** Re-delivery is a property the
design leans on: a crash between committing bytes and advancing the cursor, a
reconnect carrying what was in flight, and a hibernating Durable Object waking
with a position behind what it truly sent all re-send deliberately. Treating
that as a gap made the recovery path report data loss.

**A gap must not be permanent.** The cursor refuses to move past one, which is
right, so every later entry is also a gap. Reporting an error and waiting for
someone to notice meant nobody did: the fuzz produced a replica wedged at
position 108, still being sent 118, 119 and 121, rejecting all of them while its
rows silently stopped updating. `status().needsResync` now says so, and the
repair is a reconnect, which is the catch-up any returning device already runs.

### One place a cursor may jump

A snapshot arrives as its own frame carrying its position, and adopting it moves
a replica's cursor there in one step. That is the only permitted jump: a gap
arriving as an ordinary entry is still refused, because a gap in the log is data
nobody will mention again. It is safe here for a reason unrelated to trust, in
that the snapshot covers every position at or before it.

Adopting **merges** rather than replaces. Identities are preserved, so a replica
arriving with unsent offline work keeps it and pushes it afterwards like any
other local write. Verified end to end: a replica 30 entries behind, whose tail
no longer exists, converges and keeps a note nobody had seen.

## Consequences

- **What ADR-0217 said about no party verifying another's claim is withdrawn.**
  The authority now verifies a precondition. It is a fact about what it sent
  rather than a claim about content, but the sentence is no longer true.
- **Public generations are deferred.** Snapshot folding answers the current log
  growth problem. A future root-document Compact action, if measurements earn
  it, will decide whether a private replacement identity is sufficient or a
  larger protocol is needed.
- **Server-side history is gone.** ADR-0214's `history.sqlite3` on each device
  is now the only full history. Relocated, not lost, and a deliberate loss of
  the ability to restore the authority to an arbitrary past point.
- **The previous snapshot is kept.** A poison entry is one row and repairable
  (ADR-0218); a bad snapshot replaces history and is not, so one spare is the
  only way back.
- **Tombstones are now the only thing that grows, on the device AND on the
  authority.** They remain a non-problem at realistic churn, about 14 deletions
  a day for a decade to reach 100 MB of device memory, with `store.pressure()`
  reporting the ratio so it is watched rather than argued about. But the
  authority no longer escapes them either. A future Compact action would have
  to account for the identity and offline-work loss boundary, which ADR-0256
  deliberately leaves unbuilt.
- **A headline claim in this record was wrong for a day.** It said storage
  becomes constant, on reasoning rather than on measurement, and the bench
  written to confirm it refuted it instead. Every quantitative claim here now
  names the script that produces it.
- **The retention window and the 90-day deletion promise are withdrawn as
  mechanisms.** Deleted data now disappears at the next snapshot, which is a
  function of write volume rather than of a policy.
- **Four bugs came from running this rather than from testing it.** Two from
  Cloudflare (a trigger that thrashed, a refusal that crossed wires) and two
  from a randomised schedule (re-delivery read as a gap, a gap that wedged a
  replica forever). Scenario tests find bugs someone already imagined; these
  were not among them, and the fuzz is kept for that reason.
- **What the fuzz covers, and what it cannot.** Three replicas, random creates,
  updates, deletes and prose, random disconnects and reconnects, snapshots
  firing throughout, compared against a model held outside the system so that
  every replica agreeing on the wrong answer still fails. It runs in one process
  over an in-order wire.
- **Still uncovered, and worth naming rather than implying.** Genuine
  hibernation eviction, which is production code in the Durable Object adapter
  that has never executed; a socket dying part way through a chunked snapshot;
  more than three replicas; a lens mismatch between devices; and a stall
  observed once against Cloudflare that has no cause and is not claimed fixed.
