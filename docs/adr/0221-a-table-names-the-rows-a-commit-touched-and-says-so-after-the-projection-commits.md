# 0221. A table names the rows a commit touched, and says so after the projection commits

- **Status:** Accepted
- **Date:** 2026-08-08
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0187](0187-a-bound-handle-reports-staleness-tables-can-name-rows-values-cannot.md)
  (the invalidation shape and its laws, which this satisfies unchanged),
  [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  (one document, rows nested on a table root),
  [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  (the projection `db.query` reads).
- Evidence: `packages/app/evidence/data/delta-names-the-row.test.ts`,
  `packages/app/evidence/data/bench/subscription.ts`,
  `packages/app/src/data/store/store.test.ts`.

- **Amended in the shape it delivers.** The ids are what stands: `subscribe`
  hands the listener the rows a commit touched, collected from the table root's
  own `'delta'` and delivered after the commit settles, exactly as this record
  says. What is gone is everything they used to arrive inside. There is no
  `createInvalidationDispatcher`, no `TableInvalidation`, and no `{scope}` arm;
  a listener is handed a `readonly string[]`. That family was deleted with
  `@epicenter/lens` and did not come back with the ids.

## Context

The store had no subscription. `list()` was a snapshot and nothing told a reader
that a row had changed, so every application on it re-scanned after each of its
own mutations and had no way at all to hear about a change that arrived from a
peer. Honeycrisp paid for that with an async `refresh()` after every write, a
generation counter whose only job was to discard the results of races between
overlapping refreshes, and a one-second poll per open note.

`store.ts` recorded, correctly, that `observeDeep` reports a nested row's field
edit as an event on the TABLE ROOT with `keysChanged` empty, so an `observeDeep`
observer cannot say which row moved. The conclusion drawn from it was that
nothing can, and that a change could therefore only ever be reported as "some
table moved".

That does not follow. The same type also emits `'delta'`, whose `attrs` is keyed
by the attribute that changed, and under ADR-0215 a row IS an attribute on the
table root. Measured against `@y/y@14.0.0-rc.24`, every arm names it: `insert`
for a created row, `modify` for a field edit and for prose written three levels
down inside the row's own document, `delete` for a removed one, and the same for
bytes arriving through `applyUpdateV2`. Each measurement carries a second table
whose listener must record nothing.

A separate draft argued a whole-document signal would be more honest, because
`applyRemote` rebuilds every bound table's projection anyway. The premise was too
broad: `get`, `list`, `ids` and `document` read the CRDT directly and are correct
the instant a transaction closes, and only `db.query` reads the projection. A
coarse projection rebuild makes the SQL view lag; it does not make row-level
knowledge unavailable.

## Decision

**A bound table handle carries `subscribe(listener)`, and it delivers ADR-0187's
`TableInvalidation` with the ids the commit touched.** The grouping, the
per-table dedup and the delivery laws are `@epicenter/lens`'s
`createInvalidationDispatcher`, used unchanged: a delta-fed producer needs
exactly those laws and nothing about them is specific to a carrier.

**The ids are held during the transaction and delivered after the projection
commits.** The `'delta'` fires synchronously inside `applyUpdateV2`, before
`persist` has rebuilt the projection: at notify time the CRDT reported 2 rows
while `db.query` still reported 1, and they agreed only once `applyRemote`
returned. A subscriber therefore reads the same rows through the CRDT and through
SQL, which is the property that makes the signal usable at all.

**Nothing emits `{scope:'table'}`.** ADR-0187 introduced that arm for a carrier
gap, and an in-process store has no carrier. The arm stays, because consumers
already handle it and a future out-of-process proxy will need it, but no producer
exists in this store.

**The listener is attached on the first subscription and detached on the last.**
Attaching a `'delta'` listener is what makes the type build and emit its delta,
so an application that subscribes to nothing should not pay for one.

## Consequences

The refresh discipline goes away, along with every generation counter that
existed to make it survive its own races.

The cost is much smaller than it was planned against, and that is worth saying
because the plan quoted a number nobody had measured. On 20,000 rows a commit
editing one row costs about 0.003 ms more with a subscriber, not 0.7 ms; the cost
only becomes visible at 2,000 rows in a single commit, where it is about 0.7 ms
on top of 2.0 ms. It scales with the CHANGE and not with the table, which is the
shape ADR-0187's trade needed to be true.

A subscriber may write from inside its own notification. The buffer is swapped
before delivery rather than cleared after, so a nested write's ids belong to its
own flush.

A subscriber that throws is contained and logged. The commit that produced the
notification is already durable, so failing the write would turn one broken
listener into everybody's data loss.

The projection is still rebuilt wholesale on a remote update rather than patched
from these ids. That is a separate decision and it stands: one rebuild is 2 ms on
the real vault, and it is one code path instead of two that can disagree.
