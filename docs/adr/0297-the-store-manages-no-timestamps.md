# 0297. The store manages no timestamps

- **Status:** Accepted
- **Date:** 2026-08-29
- **Supersedes:** ADR-0265 entirely.
- **Relates:** ADR-0295, ADR-0296

## Context

A store stamped `createdAt` and `updatedAt` onto a row whenever a table declared
instant fields by those names. The stamp had two jobs. One was product: a list
sorted by recency. The other was protocol: ADR-0277's change feed, where
`updatedAt` moving on the index row was how one socket told a device that one of
N unwatched row documents had changed and should be re-fetched.

With one document per database (ADR-0295) the protocol job is gone. A body edit
arrives in the same document over the same socket, and nested edits bubble
through `changedParentTypes` to the table root's delta listener. There is nothing
to tell a device to re-fetch, because nothing was left behind.

What remains is a product fact, and the platform is not the one that knows it.

## Decision

**The store writes no timestamps.** `manages`, the compiled
`{ createdAt, updatedAt }` resolution, and the `stamps()` path are deleted.
`field.instant()` becomes a type, not a contract.

An application that wants recency declares an ordinary field and writes it:

```ts
notes: defineTable({
  title:     field.string(),
  updatedAt: field.instant(),   // an ordinary field; nobody stamps it but you
  content:   noteMarkdownCodec,
})
```

**A content node exposes a change signal scoped to itself**, so an application can
hang its own write on an edit without reaching into Yjs observers. The signal is
scoped to the field rather than the row: a row-scoped signal would fire on the
write it caused, and every application would have to break its own loop.

## Consequences

- The platform stops holding an opinion about time, and a table that wants no
  timestamp declares none and stores none.
- The stamp is no longer inside the edit's transaction. A crash between an edit
  and the application's write leaves a stale timestamp: a wrong "edited three
  minutes ago", not a corrupt row.
- Every application that wants a recency-sorted list writes a small debounced
  observer. That is duplicated work across applications, and it is the price of
  the platform not writing rows nobody asked for.
- `deriveOnCommit`'s remaining choreography goes with it: the separate follow-up
  commit, the `updateRow`-never-`createRow` resurrection guard, and the
  crash-leaves-a-stale-shadow trade. Derivation and its write now share one
  transaction with the edit that caused them.

## Considered alternatives

- **Keep the store-managed stamp, declared per table.** Refused, narrowly. It is
  already opt-in, it costs about one item per row, and only the store sees an
  edit made through an editor bound directly to a rich field, so it is the only
  party that can stamp atomically. It loses because a platform that writes
  fields an application did not ask for has to be right about time forever, and
  the failure it prevents is a slightly stale label.
