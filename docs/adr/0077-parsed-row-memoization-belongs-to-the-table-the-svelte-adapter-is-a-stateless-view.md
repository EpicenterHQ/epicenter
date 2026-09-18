# 0077. Parsed-row memoization belongs to the table; the Svelte adapter is a stateless view

- **Status:** Accepted
- **Date:** 2026-06-27

- **The adapter holds a projection again.** `fromData` keeps a `SvelteMap` of
  parsed rows per table, seeded when it is called and patched with the row ids
  each commit names. That inverts this record's headline, and it was driven by
  a measurement this record did not have: reading every row costs about two
  microseconds each, so a list over ten thousand notes paid roughly twenty
  milliseconds per keystroke
  (`packages/app/evidence/data/bench/list-per-keystroke.ts`).
- **What this record got right is unresolved rather than refuted.** Its
  argument is about LAYER, not about caching: parse cost belongs to the table,
  where every consumer gets it, rather than to one framework's adapter. That is
  still the better place. The reason it is not there is mechanical: the memo
  here was keyed by a stored value's object reference, and Yjs 14 mutates a
  row's type in place rather than replacing it, so reference identity no longer
  detects a change. A table-level memo would have to be invalidated by the same
  delta that now names the rows, which is a real design and nobody has written
  it.

## Context

`fromTable` (in `@epicenter/svelte`) adapts a workspace `Table` into reactive
Svelte state. Today it seeds a `SvelteMap`, keeps it in sync by re-reading each
changed id on `observe()`, attaches the `nonconforming` / `newerWriter` buckets
with `Object.defineProperties`, and exposes `[Symbol.dispose]()` that every
consumer state module threads upward.

Grounding the design against Svelte 5 source (v5.56.3) and `table.ts` overturned
the assumption that justified that shape:

- A `SvelteMap`'s list reads (`values()`, iteration) are **coarse**: `#read_all`
  reads `#version`, which increments on any add, delete, or value-replace. Every
  list view (`active`, `deleted`, `all`) re-runs on any row change. The map's
  only fine-grained surface is the per-key `get(id)`.
- So the `SvelteMap` was never really a reactivity structure. It was an
  **incremental parsed-row cache** living in the UI framework: it re-parsed only
  changed rows on `observe()` (`table.get(id)`) and preserved the object identity
  of unchanged rows. That is what forced the `[Symbol.dispose]()` ceremony, and
  what made a lazy `createSubscriber` lifecycle impossible (an unread cache goes
  stale).
- `table.scan()` is not cached: it re-parses every stored entry (TypeBox
  `Value.Check` + `migrate`) and returns fresh row objects on every call.
- `YKeyValueLww` holds one entry object per key in `_map` and only replaces it
  when that key changes, so the stored value is a **stable object reference**
  for unchanged rows. A cache keyed by that reference can be both incremental and
  identity-preserving.

Parse cost and row-object identity are table concerns, not Svelte concerns.
Binding them to a framework object is the wrong layer: it duplicates rows,
excludes non-Svelte consumers (materializers, CLI scripts, `findValid`, direct
`scan()` callers), and leaks lifecycle into every consumer.

## Decision

Split the two concerns by layer.

- The **Svelte adapter is a stateless view**. `fromTable` holds no mirror. It
  reads live through the table behind a single `createSubscriber`, exposing
  `all`, `nonconforming`, `newerWriter` (one shared `$derived` over `scan()`),
  and `byId(id)`. No `SvelteMap`, no `Object.defineProperties`, no
  `[Symbol.dispose]`: `createSubscriber` starts the observer while an effect
  reads and tears it down when none do.
- **Parsed-row memoization and identity stability live in `createReadonlyTable`.**
  `parseRow` is memoized by the stored value's object reference (a
  `WeakMap<storedValue, Result>`), so `scan()` and `get()` reparse only changed
  rows and return the same row object for an unchanged row across calls. `scan()`
  stays the public classified-read surface from [ADR-0001](0001-classified-scan-read-surface.md);
  the cache sits behind it.

Reactivity granularity is the adapter's job; parse memoization and row identity
are the table's job.

## Consequences

- `fromTable` collapses to a stateless view and the dispose ceremony disappears
  from every consumer. Consumers move from the `SvelteMap` shape (`values()`,
  `size`, `get`, `has`, `keys`) to `{ all, byId, has, allIds, nonconforming,
  newerWriter }`. This is a wide but mechanical, compile-checked migration.
- The expensive cost (parsing) and the identity-churn risk that a stateless
  adapter would otherwise introduce are both solved once, in the table, for every
  consumer, not just Svelte. Without the cache, a stateless adapter would re-parse
  all rows and hand out fresh row objects on every change, churning keyed child
  props and identity-keyed deriveds. The cache must ship with the adapter change,
  not after it.
- The adapter loses the map's one fine-grained surface: `byId` re-runs on any
  table change, where the old `map.get(id)` re-ran only when that id changed.
  Acceptable below ~10k rows at human-speed edits; the named seam to restore it
  is a per-id `createSubscriber` keyed by id, added only under profiler evidence.
- The table cache assumes `YKeyValueLww` keeps a stable stored-value reference
  for unchanged rows (true today). If that invariant ever changes, the cache
  silently degrades to full re-parse rather than breaking correctness.
- `scan()`'s contract is unchanged; callers outside Svelte transparently get the
  incremental parse and stable identities.
