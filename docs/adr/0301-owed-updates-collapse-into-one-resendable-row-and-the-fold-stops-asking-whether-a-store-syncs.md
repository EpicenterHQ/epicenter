# 0301. Owed updates collapse into one resendable row, and the fold stops asking whether a store syncs

- **Status:** Accepted
- **Date:** 2026-08-31
- **Amends:** [ADR-0239](0239-a-stores-kind-is-its-sync-value-and-delivery-bookkeeping-is-internal.md) at the fold's use of the store's kind, which stops being a constructor argument; [ADR-0298](0298-the-authority-is-byte-blind-and-a-cursor-is-a-log-position.md) at owed appends staying individually addressable
- **Relates:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md), whose ordered queue is unchanged; [ADR-0300](0300-accepted-edits-are-live-immediately-and-persistence-and-sync-are-best-effort.md), whose transient delivery queue was withdrawn hours later by [ADR-0302](0302-a-local-edit-is-offered-to-the-authority-once-it-is-durable.md), which is why the merge has no second queue to keep in step

## Context

An owed append cannot fold. The sender names what it offers by id and an
acknowledgement covers `id <= throughId`, so a row the authority has not
numbered has to survive under its own id until it is stamped. That rule made
the fold ask a second question, and ADR-0239 answered it with a constructor
argument: a store that syncs collapses only the acknowledged prefix, a store
that does not collapses everything.

The consequence is that the chain of a device with no connection grows without
bound, because nothing is ever acknowledged and therefore nothing is ever
foldable. That is the opposite of where the growth belongs. Measured against
the real IndexedDB port (`evidence/browser/port-cost`):

```txt
  chain rows      cold open      ack that stamps them
        64          1.8 ms                    0.8 ms
      1000         53.7 ms                  107.8 ms
      4000        555.0 ms                  835.8 ms
```

Both curves are charged to the offline device, and the cold open is charged on
every launch until it reconnects.

The constraint producing this is narrower than it looks. Per-row identity is
needed only while a submission naming those ids is in flight. The sender is
single-flight and coalesces the whole outbox into one `mergeUpdatesV2` payload
before sending, so the bytes on the wire are already merged; the ids exist to
address a receipt, not to describe the payload. A device with no socket has
nothing in flight, ever, which is exactly the case the current rule
pathologizes.

## Decision

**Owed updates collapse into one owed row.** When the count of owed rows
reaches `SNAPSHOT_FOLD_THRESHOLD` and no submission is in flight, they are
merged with `Y.mergeUpdatesV2`, written as one row, and the rows they replace
are deleted. New appends land as their own rows afterwards, so the merged row
is a periodic collapse and never an accumulator: rewriting it per edit would
write every owed byte on every keystroke.

**The merged row takes a new id above every existing id.** This is the whole
safety argument and it is not an implementation detail. An acknowledgement
stamps `id <= throughId AND authoritySeq IS NULL`. A merged row that inherited
the lowest id it replaced would be stamped by an acknowledgement for a
submission that did not carry all of its bytes, marking unsent work as sent and
losing it silently. A merged row above the range is stamped by no earlier
acknowledgement, so a merge that races an in-flight submission costs a
redelivery the authority absorbs by idempotence. The invariant is therefore a
performance guard, not a correctness guard, and violating it cannot lose work.

**The fold stops asking whether a store syncs.** Two rules, chosen by the row
rather than by the constructor:

```txt
  authoritySeq IS NOT NULL   replay into a fresh document and re-encode whole,
                             which is the strongest compaction available and
                             the only one that realizes `gc: true`

  authoritySeq IS NULL       merge with `mergeUpdatesV2`, which preserves a
                             resendable delta rather than a whole document
```

A local append is written with `NO_AUTHORITY` rather than `null`, so `null`
means owed and nothing else. The column was already three-valued and already
carried this sentinel for received bytes and for a non-syncing baseline;
extending it to local appends costs one integer per row and deletes the
argument. ADR-0239's objection to a sentinel, that it would collide the day a
log position started at zero, is answered by `NO_AUTHORITY = 0` against
positions of one and above, which that record already relies on.

A store with no authority then holds no owed rows at all, so the second rule
never fires for it and it folds everything, which is what it did before.

## Consequences

- An offline device's chain is bounded by the threshold, so a long flight
  costs the same open as a short one.
- An acknowledgement stamps at most one merged row plus whatever accumulated
  since, rather than every append made while offline.
- The durable record learns nothing about the socket, which is better than
  this record originally priced. The guard is `lastCoalescedId`, the highest id
  the sender has ever been handed: a row above it has never been in any
  submission, so replacing it is unconditionally safe. A monotone counter
  rather than a flag, because a flag gets stuck set when a socket dies
  mid-submission, which would disable merging in exactly the offline case the
  merge exists for.
- The storage epoch goes to `v3` and pre-existing local records are stranded
  (`STORE_GENERATION`, `packages/app/src/data/store/browser.ts`). A `v2` local
  store wrote its own appends with a NULL position, and NULL now means owed on
  every store kind, so those rows read under this shape would be offered to a
  sender that does not exist. The value changed rather than the schema, which
  is exactly the migration the address scheme exists to refuse (ADR-0292).
- Merging is a write that does not exist today: roughly one merged row per
  threshold of appends, against the appends it deletes.
- `mergeUpdatesV2` compacts less than a whole-document re-encode, so an owed
  suffix stays larger than an acknowledged prefix of the same content. It is
  bounded by the threshold and it is what keeps the bytes resendable.
- The poison-entry story is unchanged. A corrupt owed update already fails at
  `coalesce`, which merges the same bytes today; merging earlier moves the same
  failure earlier and names no new position.
- ADR-0298's derived cursor and derived outbox are untouched. The cursor is
  still `MAX(authoritySeq)` and the outbox is still the null rows. This record
  changes what a null row may be replaced by, not what null means.

## Considered alternatives

- **Merge only at open and after each acknowledgement.** Both moments are
  provably not in flight, so this needs no coupling at all. Refused as the
  destination because it does not fix the case that motivated the record: an
  offline device receives no acknowledgement and does not reopen, so it still
  reaches the reconnect with every append addressable and still pays the wide
  stamp once. It remains a legitimate first step and nothing here forbids
  landing it that way.
- **Keep the lowest id on the merged row.** Refused, and it is the alternative
  this record exists to refuse. It is the reading a person reaches for first
  and it converts a redelivery into silent loss.
- **Drop the acknowledgement column and store a cursor row.** Refused for the
  reason ADR-0298 gave: a stored cursor can commit in a transaction its bytes
  did not, and a cursor ahead of its bytes skips replay permanently and
  invisibly. A derived cursor cannot express that state.
- **Let the sender hold ids stable by never merging while online.** Refused as
  a rule that optimizes the case that is already fine. An online device's owed
  set is retired within a round trip; the growth is entirely an offline
  phenomenon.
