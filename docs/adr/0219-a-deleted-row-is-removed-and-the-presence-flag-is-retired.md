# 0219. A deleted row is removed, and the presence flag is retired

- **Status:** Accepted
- **Date:** 2026-08-07
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md)
  at deletion only. Withdrawn: clear-and-flag, the `!presence` attribute and its
  `'present' | 'absent'` grammar, and the reuse story in which writing at an
  absent address revives it. What survives untouched is everything else 0212
  decided: one root per table, rows nested beneath, the reserved `!` prefix, and
  a row's document as an inherent container Epicenter never reads.
- **Amends:** [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  at one clause, its listing of `!presence` as part of the surviving grammar.
- **Amended by:** [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md)
  at workspace replacement: a rebuild copies live rows into a fresh document
  and retires the old document. It is distinct from snapshot folding within
  the current document.
- Evidence: `packages/app/evidence/data/bench/tombstones.ts`,
  `packages/app/evidence/data/deletion-model.test.ts`.

## Context

ADR-0212 deleted a row by clearing its fields and setting a reserved
`!presence` attribute to `'absent'`, leaving the row's container attached to the
table root forever. Clearing was chosen over removing the container on the
stated grounds that removal "destroys a concurrent edit" while clearing
"converges with the tombstone held and the peer's edit retained".

Two accumulations were being conflated. The authority's log growing is the cheap
one: about 4 MB a year against 10 GB, which ADR-0217 refuses to compact on
exactly that basis. A tombstone is the other, and it is worse shaped, because
every device pays for it in memory on every load, forever. A phone does not have
10 GB of RAM.

## Decision

**A row is deleted by removing its attribute from the table root. A row exists
if and only if the table root holds a nested type at that key.**

### The price of the flag

A dead row, measured over four deletion patterns, which turn out to land within
6% of each other:

| | per dead row | twenty a day for a decade, showing 2,000 live rows |
| --- | --- | --- |
| clear-and-flag | 7.9 items, 123 B | 582,000 items, **458 MB** resident |
| remove the container | 2.0 items, 44.5 B | 156,000 items, **100 MB** resident |

Memory tracks struct count rather than encoded size, at roughly 1 KB of rss per
item (ADR-0215), which is why the item column is the one that decides this and
the byte column is nearly irrelevant.

### The benefit it was buying does not exist

Swept over both models, a concurrent delete and edit are **indistinguishable to
a reader**: the row is gone, both devices converge, and delete wins whichever
side goes first. The retained edit is retained only inside the CRDT and is
reachable through no store verb.

Where the two do differ, retention is the worse half. The peer's edit sits as a
hidden field on the corpse, and reviving that address **resurrects it**, so a row
every device agreed was deleted comes back carrying an edit made after its
death.

### Once nothing is left behind, the flag has no work

`PRESENCE_ATTRIBUTE`, `presenceOf` and the `Presence` type are gone. It was
exported and imported by nobody. `isLive` becomes `hasRow`, `documentContainer`
loses a duplicate lookup, and `listRowIds` stops walking the dead, so its scan
is O(live) rather than O(ever-existed); ADR-0212 priced that scan at 24.9 ms for
a thousand live rows among a hundred thousand.

The reuse path goes with it. `writeRow` allocated the document container on
every write "only when absent, so re-creating at a reused address gets a fresh
one", which contradicted ADR-0215's claim that a container is allocated with the
row and never lazily. With no reusable address it mints exactly once, and that
claim is now true. `update` on a deleted id reports `RowAbsent`, and `create`
mints a fresh id.

## Consequences

- **This buys time, it does not remove the ceiling.** A decade of ordinary churn
  still reaches 156,000 items and 100 MB to show 2,000 rows. Only a rebuild
  reclaims tombstones, and a rebuild mints new struct identities, which is the
  operation ADR-0214 refuses because it destroys a device's offline work.
  Measured: rolling the log over by snapshot reclaims **0** items, by rebuild
  **142,000**. They are the same operation with opposite trade-offs and there is
  no third option.
- **`evidence/deletion-model.test.ts` keeps testing both models side by side.**
  It is the record of why the choice was made, and reducing it to the winner
  would delete the reasoning.
- **The existing suite passed unchanged before this landed**, which means nothing
  pinned the property. It is pinned now, including a test that fails if a dead
  row ever costs more than 60 bytes through the store.
- **The reserved `!` prefix stays**, now carrying only `!doc`. `packages/lens`
  still uses `!presence` as its example of a name the prefix protects; that
  example names a dead attribute and should be updated when that file is next
  touched.
