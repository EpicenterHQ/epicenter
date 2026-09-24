# 0311. A table is a held projection, and everything cheaper than rebuilding is read through

- **Status:** Accepted
- **Date:** 2026-08-31
- **Amends:** [ADR-0221](0221-a-table-names-the-rows-a-commit-touched-and-says-so-after-the-projection-commits.md) at nothing it decided: the ids it specified are restored, and this record is the consumer it was written for.
- **Reopens:** [ADR-0077](0077-parsed-row-memoization-belongs-to-the-table-the-svelte-adapter-is-a-stateless-view.md), whose headline this inverts. Its layering argument is not answered here and stays open, below.
- **Relates:** [ADR-0187](0187-a-bound-handle-reports-staleness-tables-can-name-rows-values-cannot.md) (a table can name rows and a value cannot), [ADR-0294](0294-a-database-is-sized-against-a-measured-device-budget-not-an-assumed-ceiling.md) (memory is the only constraint, which this record shows was scoped to the document and not to the screen), [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) (one document, rows nested on a table root), [ADR-0309](0309-a-field-holds-a-value-or-a-node-and-the-retired-words-fail-the-build.md) (the vocabulary this uses)

## Context

A row is CRDT structs. `{ id, title, pinned }` does not exist anywhere until
something reads each attribute and builds it, and building one costs about two
microseconds. The Svelte adapter held nothing, so every read built every row.

That is affordable exactly until a list is long. Measured against the real
store (`packages/app/evidence/data/bench/list-per-keystroke.ts`):

| notes | rows walk | filter | sort | one derive |
| --- | --- | --- | --- | --- |
| 1,500 | 2.56 ms | ~0 | 0.55 ms | 2.4 ms |
| 10,000 | 38.85 ms | 0.59 ms | 4.43 ms | 43.9 ms |
| 50,000 | 220.71 ms | 0.96 ms | 44.05 ms | 265.7 ms |

Eighty-eight percent is the walk. The filter is free and the sort is a tenth.
The commits that trigger it cost a third of a millisecond.

**And the fine-grained signal does not spare the list.** Honeycrisp sorts by
`updatedAt` and writes `{ title, updatedAt }` back to the row from a coalescer
hung on the node's signal, so a keystroke produces two commits and the list
must wake for the second one under any design: the note it names has just moved
to the top. Choosing one signal against three is 44 ms against 88 ms at ten
thousand rows. Both are past the frame budget before any DOM work.

So the signal count was never the question. The question was whether the rows
are rebuilt.

ADR-0294 concluded that "memory is the only constraint; time is not". That is
true of opening and reading a document and it was never a statement about the
screen, which nobody has instrumented.

## Decision

**A table is HELD. Everything cheaper to rebuild than to hold is read through.**

```txt
 ┌─ THE TRUTH ─ one Y.Doc, per opened database ───────────────────┐
 │                                                                 │
 │   tables:notes   → n1 ⟨title⟩⟨pinned⟩⟨content ▓▓▓ a node⟩        │
 │                    n2 ⟨title⟩⟨pinned⟩⟨content ▓▓▓⟩               │
 │   tables:folders → f1 ⟨name⟩                                    │
 │   kv             → ⟨theme⟩⟨fontSize⟩                            │
 └─────────────────────────────────────────────────────────────────┘
        │                │                │              │
        ▼                ▼                ▼              ▼
 ┌───────────┐   ┌───────────┐   ┌─────────────┐  ┌─────────────┐
 │ SvelteMap │   │ SvelteMap │   │     kv      │  │ persistence │
 │   notes   │   │  folders  │   │   NO MAP    │  │   NO MAP    │
 │           │   │           │   │             │  │             │
 │ n1 → {…}  │   │ f1 → {…}  │   │ get(key) =  │  │ get() =     │
 │ n2 → {…}  │   │           │   │  ONE attr   │  │  one enum   │
 │           │   │           │   │  + ONE check│  │  from a     │
 │ own seed  │   │ own seed  │   │             │  │  closure    │
 │ own sub   │   │ own sub   │   │ create-     │  │ create-     │
 │           │   │           │   │ Subscriber  │  │ Subscriber  │
 └───────────┘   └───────────┘   └─────────────┘  └─────────────┘
        │                │                │              │
        └────────────────┴────────────────┴──────────────┘
                              ▼
                the screen reads all of it synchronously
```

One rule decides every surface, and it says no more often than yes:

| surface | cost to answer a read | held? |
| --- | --- | --- |
| a table | 10,000 rows built | **yes** |
| `kv` | one attribute, one check | no |
| `persistence` | one enum from a closure | no |
| the document | it is the truth | never copied |

**Each table is its own `SvelteMap`, keyed by row id.** Not one map for the
database: `fromData` wraps each declared table separately, so a commit naming
rows in `notes` touches the notes map and consults no other.

**The map IS the signal.** Reading one key tracks that key, iterating tracks
all of them, so a list wakes on any change and a component reading one row
wakes only for that row. No new signal is added to the store for this; the ids
ADR-0221 already specified are enough.

**Seeded eagerly, because it cannot be seeded lazily.** An application reads
`rows` inside `$derived`, and writing Svelte state from there is
`state_unsafe_mutation`. `fromData` therefore walks each declared table once
when it is called and is no longer free.

**Never torn down.** The subscription is held for the wrapper's life rather
than ref-counted to its readers. A projection detached from its source does not
become free; the object stays alive, the updates stop, and the next reader is
served rows from before it looked away. Stale is worse than absent, so it dies
with the document it mirrors and with nothing else.

```ts
function reactiveTable(table) {
  const rows = new SvelteMap();
  for (const id of table.ids()) {          // SEED, once, eagerly
    const row = table.get(id);
    if (row !== undefined) rows.set(id, row);
  }

  table.subscribe((rowIds) => {            // PATCH, forever
    for (const id of rowIds) {
      const row = table.get(id);
      row === undefined ? rows.delete(id) : rows.set(id, row);
    }
  });

  return {
    ...table,                              // create / update / delete / watch
    get rows() { return [...rows.values()]; },  // iterate → tracks every key
    get(id)   { return rows.get(id); },         // one key → tracks that key
  };
}
```

Nothing here calls `createSubscriber`. The map is the signal.

A keystroke, end to end:

```txt
  type one character into n1's content node
     │
     ├─▶ 🔔 the node's own signal      the editor and the preview update.
     │                                 no map is touched. kv is not touched.
     │
     └─▶ the app writes { title, updatedAt } back to n1
              └─▶ 🔔 the notes table, naming ["n1"]
                       └─▶ get("n1") → build → rows.set("n1", {…})   2 µs
                           n2 untouched · folders untouched · kv untouched
```

**`kv` and `persistence` keep `createSubscriber` and hold nothing.** Ten keys
and one enum are the rule saying no, not an exception to it.

## Consequences

- Per keystroke, one row is rebuilt rather than every row. At ten thousand
  notes that is roughly two microseconds against twenty milliseconds.
- `fromData` acquires a lifetime and a cost at call time. An application that
  declares a table it never renders pays for it once at open.
- A component reading one row wakes only for that row, which the store's
  signals alone could not do. The seam ADR-0077 named for restoring per-key
  granularity is satisfied by the framework rather than by the store.
- The projection can be wrong in exactly one way: a missed eviction serves a
  stale row. `packages/svelte/src/from-data.svelte.test.ts` fails on it when
  the patch is removed, which is the only reason this is safe to hold.
- Reads must happen inside a reactive context. `createSubscriber` is a no-op
  outside effect tracking (`if (effect_tracking())` guards its whole body), so
  what must be inside the context is the CALL, not the value:

  ```svelte
  const v = app.kv.get('theme');             ❌ frozen at init, forever
  {app.kv.get('theme')}                      ✅ the call is in the render effect
  const v = $derived(app.kv.get('theme'));   ✅ $derived re-runs the call
  ```

  The same is true of `app.tables.notes.rows`, and of `$state`. The compiler
  cannot warn through a getter, so the failure is a correct value that never
  updates: no error, no wrong pixel, until something changes and nothing moves.
- `kv.get(key)` was changed to read one attribute and check one field rather
  than conform the whole object. That is what makes the rule above a size
  argument rather than a kind argument: after it, both surfaces cost exactly
  what their signatures say.

## What this record does not settle

ADR-0077 argued that parsed-row memoization belongs to the TABLE, not to one
framework's adapter, so every consumer gets it: the artifact mirror, the
export, benches, a Bun process. That argument is about layer and it is still
the better one. It is not implemented for a mechanical reason rather than a
principled one: its memo was keyed by a stored value's object reference, and
Yjs 14 mutates a row's type in place instead of replacing it, so reference
identity no longer detects a change. A table-level memo would have to be
invalidated by the same delta that now names the rows.

Moving it down would cost the per-key waking this record gets for free. Nothing
reads a single row outside a list today, so that cost is currently theoretical
and the layering benefit is not.

## Considered alternatives

- **One signal for the whole document.** Rejected on measurement: it doubles
  the list's work per keystroke, and the list is already the dominant cost.
- **A per-row signal in the store.** Rejected because the reactive map already
  is one, and because the ids the store once carried were removed for having no
  reader. The reader now lives in the adapter.
- **Hold `kv` too.** Rejected. Holding is a defence against an expensive
  rebuild, and after `kv.get` reads one key there is no rebuild to defend
  against. Holding it would buy nanoseconds and cost a copy that can be wrong.
- **Ref-count the projection to its readers.** Rejected: navigation would
  destroy and re-seed it, and a detached projection goes stale rather than
  free.
