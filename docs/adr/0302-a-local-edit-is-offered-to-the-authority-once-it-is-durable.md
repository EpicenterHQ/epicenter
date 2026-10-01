# 0302. A local edit is offered to the authority once it is durable

- **Status:** Accepted
- **Date:** 2026-08-31
- **Amends:** [ADR-0300](0300-accepted-edits-are-live-immediately-and-persistence-and-sync-are-best-effort.md) at the transient sync-delivery queue, which is withdrawn. Its other half stands: an edit is still accepted live and neither path may throw through the editor.
- **Relates:** [ADR-0238](0238-the-live-document-is-the-truth-while-open-and-persistence-is-a-visible-debt.md), whose rule this restores; [ADR-0301](0301-owed-updates-collapse-into-one-resendable-row-and-the-fold-stops-asking-whether-a-store-syncs.md), whose merge no longer has a second queue to keep in step

## Context

ADR-0300 gave the store a transient in-memory delivery queue beside its durable
outbox, so that sync could offer an edit before local persistence accepted it.
The case it exists for is narrow: **local storage refusing writes while the
network works.**

The cost is not narrow. `coalesce` had to reconcile two representations of one
question, deduplicating by id, merging into a map, and sorting, and both
`acknowledge` and ADR-0301's `mergeOwed` had to prune the second queue on the
way past. That reconciliation was the most complicated code in the store, and
it made a function whose job is "what do I still owe" unreadable.

Re-pricing it against what the sender actually does settles it. The sender is
an idle timer of one second (`sync/client.ts`), and it reads the outbox when
the timer fires rather than when it is nudged. A persistence flush is a
microtask, and on a synchronous port it is inline. So in every case except a
storage engine that is genuinely refusing, the durable outbox already holds the
work by the time anyone asks for it, and the transient queue answers a question
nobody was asking a second early.

What it buys is therefore only this: a device whose disk is broken can keep
syncing. That is a real capability and it is worth naming rather than pretending
otherwise. It is also a rare, persistent condition, on a session that has
already lost its durability guarantee.

## Decision

**The sender reads the durable outbox and nothing on top of it.** A local edit
is offered to the authority once it is durable. A blocked flush leaves nothing
new to send, and `persistence.get()` reports `blocked` while that is true.

That report currently reaches nobody. No application reads it: the only
consumer outside this package is `persistOnHide` calling `flush()`
(`packages/app/src/data/store/flush-on-hide.ts`). So the honest statement of this
decision is that a blocked device stops syncing SILENTLY, and the surface that
would make it visible is unbuilt. That surface is the price of this record, and
it is owed rather than paid.

**Acceptance and the nudge do not move.** A local transaction still updates the
live document and the UI synchronously, `onLocalWork` still fires at acceptance
rather than at flush, and neither persistence nor delivery may throw through the
editor. The idle timer between the nudge and the read is what makes nudging
early correct.

**A device whose storage is refusing writes stops syncing.** That is the
capability withdrawn here, stated plainly so a later reader does not rediscover
it as a bug.

## Consequences

- `coalesce` reads one collection. The dedup, the map, and the sort are gone
  with the queue they reconciled, and so are the prunes in `acknowledge` and
  `mergeOwedIfLong`.
- One representation of "what is owed" instead of two, which is the same
  argument ADR-0298 makes for deriving the cursor and the outbox rather than
  storing them: two copies of one fact can disagree.
- ADR-0301's merge no longer has to keep a second queue in step, so a merge
  that fails to commit leaves the rows it would have replaced exactly where
  they were, with nothing in memory claiming otherwise.
- An edit made while storage is blocked reaches no peer until storage recovers.
  Previously it could reach the authority and be restored from there.
- The window in which an edit exists only in memory is now bounded by the
  flush rather than by the flush or the acknowledgement, whichever came first.

## Considered alternatives

- **Keep the queue and document it better.** Refused. The problem was not that
  the reconciliation was unexplained; it was that one question had two answers
  that had to be merged at every call site that asked it.
- **Nudge on durable growth instead of at acceptance**, which is what ADR-0238
  did before ADR-0300 replaced it. Unnecessary: the sender waits a second
  before reading, so an early nudge and a late read already compose. Restoring
  `onOutboxGrew` would add a listener to solve a race that the idle timer
  closes.
- **Retry the flush on a timer so a transient refusal self-heals.** Refused
  here as a separate question. It is a persistence decision rather than a
  delivery one, and the failures that actually occur (quota, eviction, a
  corrupt database) are persistent rather than transient, so a timer would
  spin rather than heal.
