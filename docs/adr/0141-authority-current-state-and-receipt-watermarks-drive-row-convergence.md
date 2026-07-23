# 0141. Authority current state and receipt watermarks drive row convergence

- **Status:** Superseded by [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md)
- **Date:** 2026-07-17
- **Supersedes:** [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0133](0133-row-authority-stores-documents-as-sequence-addressed-update-logs.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md)

## Context

The current protocol combines one outgoing sealed round with incoming outcome
pagination. The authority persists canonical rows, repeated scalar outcomes,
document outcomes, and a retry receipt. The client duplicates related round
facts and retires its visible sealed overlay only when the combined response
stream reaches a moving head.

The product needs authority-ordered scalar folding, exact retry, incremental Yjs
delivery, complete offline replicas, and continuous local visibility. It does not
need scalar authorship history or a combined push and pull exchange.

## Decision

One `RowIntent` remains the mutation atom from local admission through authority
folding. Open intents are durable and compactable. At most one sealed generation
is an immutable retry image while newer edits continue in open intents. Every
structurally valid authorized next round folds without domain rejection. Scalar
changes resolve in authority acceptance order; Yjs document updates merge.

The client mints and durably stores its candidate replica id before enrollment.
Enrollment is idempotent for that id. A lost enrollment response therefore
returns the same receipt instead of minting an orphan permanent capability. The
hosted deployment checks for that exact existing enrollment before applying its
allowance policy to a genuinely new receipt; an unseen refused workspace still
creates no authority storage.

The authority owns one current-state convergence feed:

```txt
live rows            complete scalar postimage + changed sequence
deletion tombstones  permanent retired row address + changed sequence
row change index     retained sequence-to-address markers
documents            compact baseline + retained sequenced Yjs tail
replica receipts     accepted round + accepted digest + applied-through sequence
meta                 authority head + retention floor
```

The bounded row change index replaces historical scalar postimage payloads. It
records only which row changed at each authority sequence. Pull pages stable
markers through a fixed head, then joins each address to its current live row or
tombstone. A row that changes beyond the fixed head therefore cannot disappear
from an older page: its older marker still selects the newer current postimage,
and its later marker makes the install repeat safely. Yjs keeps an incremental
tail because resending a complete document after every edit would make small
changes transfer the full document.

Internal push and pull are separate operations. Push atomically folds one sealed
round, advances the authority head, and stores its exact receipt. A matching
round and digest is an idempotent retry. The same round with different content,
an older receipt, or a skipped round halts without mutation. Pull pages current
row state, tombstones, and Yjs updates after a checkpoint toward a fixed head.
The digest is the load-bearing fork detector: without it, different content
under an already accepted round is indistinguishable from an exact retry and can
receive a false acknowledgment.

The pull cursor and the installed-state guard are different facts. A page owns
the transport interval through `checkpoint` and fixed `through`; row entries do
not repeat the marker sequence that selected their address. A live-row entry
carries its current `changedSequence`, a tombstone carries its current deletion
sequence, and an incremental document entry carries the sequence of that Yjs
update. The client installs a row or tombstone only when its guard is at least
as new as the locally installed guard, applies Yjs updates idempotently, and
advances the page checkpoint in the same transaction. A current postimage newer
than `through` may therefore arrive early, but it cannot move the transport
cursor. Reaching `checkpoint == through` means every effect through that lower
bound is reflected locally, possibly together with newer scalar state.

Scalar fields and document content must not form an application invariant that
requires both components from one authority sequence to become visible as an
exact historical snapshot. A current scalar postimage can lead a Yjs update
beyond the fixed pull head. State that requires exact atomic interpretation
belongs inside the row-owned document. This is the deliberate price of deleting
scalar postimage history rather than recreating snapshot sessions.

Authority acceptance is atomic for one pushed batch. Replication installation
is row-atomic, not batch-atomic: different rows accepted together may become
visible at another replica on different pull pages. Applications must not place
cross-row invariants on transient remote visibility.

ADR-0130's rule that conforming runtimes never reuse a deleted row id remains
load-bearing. The authority retains each deleted address as a permanent retired
identity even after its transport marker is compacted, and a later create at
that address is a no-op. This prevents an old retained document update from
applying to a different lifetime at the same address without adding row
incarnation state.

Canonical client state remains:

```txt
confirmed authority state
+ sealed RowIntents
+ open RowIntents
= current application state
```

The client persists its last retired receipt, checkpoint, local admission head,
open intents, and optional sealed generation. Its next sealed round derives as
`retiredRound + 1`; no separate in-flight round is stored. A sealed generation
stays visible after push acceptance and retires atomically only after the
installed checkpoint reaches the authority receipt's applied-through sequence.
That transaction deletes sealed intent, installs the receipt as retired, and
preserves newer open intent. The authority receipt is the retry verdict; the
client's retired receipt is the lineage witness and local transition position.

With no sealed generation, the authority receipt must equal the client's retired
receipt. With a seal, the authority may report either that retired receipt or the
next round with the sealed digest. Any other relationship requires recovery.
Confirmed rows and tombstones retain their installed authority sequence so a
newer joined postimage cannot be regressed by an older retry or page.

Replica receipts remain until workspace deletion. Transport compaction never
expires a replica or its durable intents.

## Consequences

- Repeated scalar JSON history, combined push/pull response states, and
  duplicated in-flight metadata disappear.
- Push acceptance and pull installation have separate progress markers joined
  by one applied-through watermark.
- A locally visible edit never disappears between acceptance and canonical
  installation.
- No-op intents may advance the authority head without creating a row entry;
  pull still advances through the fixed head.
- Pull watermarks are lower bounds on installed authority state, not historical
  snapshots at an exact sequence.
- The conformance suite proves convergence under concurrent writes, pagination,
  deletion, retention movement, exact retry, and reset-only storage reopen.
- Deleted row addresses and replica receipts are permanent small authority
  records; transport compaction bounds payload history, not identity history.

## Considered alternatives

- **Retain scalar postimage history.** Rejected because a lightweight address
  marker preserves fixed-head pagination without repeating JSON payloads.
- **Page only current rows by their latest sequence.** Rejected because a row can
  move beyond the fixed head before its older page and be omitted entirely.
- **Return touched-row postimages from push.** Rejected because it duplicates the
  pull feed and needs per-row stale-install protection.
- **Add an accepted-but-unconfirmed intent generation.** Rejected because the
  sealed overlay already preserves visibility until pull reaches its watermark.
- **Replace rounds with per-field clocks.** Rejected because it changes conflict
  semantics and attaches permanent metadata to every scalar field.
- **Remove the digest.** Rejected because restored private state could otherwise
  retire different same-round content silently.
