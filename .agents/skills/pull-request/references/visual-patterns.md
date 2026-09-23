# PR Visual Patterns

## When To Read This

Read when a PR body needs a diagram: composition or ownership changes, before and after shapes, data or protocol flow, trade-off tables, or a stacked-PR journey. This is the catalog of shapes; for the prose around them, see [body-patterns.md](body-patterns.md).

## Default To The Lightest Diagram

Pick the lightest form that carries the relationship: two annotated columns, an indented tree, an arrow chain, or a small before and after block. Reserve full box drawing for genuine multi-box architecture. A heavy box around what is really a two-column mapping costs the reader more than it gives.

Rhythm: context in one to three sentences, then the visual, then one sentence on the subtle part, then the next visual. If you write more than four or five sentences with no visual, you are probably missing a diagram or code block.

## Before And After Code

The highest-value visual for a refactor. When the public API is unchanged but the internals or the call site improved, show both sides.

````md
```ts
// Before: O(n) scan every cell to rebuild a row
for (const [key, entry] of ykv.map) {
  if (key.startsWith(prefix)) { ... }
}
```

```ts
// After: composed stores, O(1) has/count
rowStore.has(id);
rowStore.count();
```
````

Use when the implementation changed significantly, performance characteristics changed, or complexity moved between layers.

## Composition Tree

When a refactor changes how modules compose, use indented tree notation, not boxes. Annotate each node with its job, and show complexity when the refactor changes it.

```txt
Before: one module doing everything
TableHelper (schema + CRUD + row reconstruction + observers)
  `-- YKeyValueLww
        |-- reconstructRow()   O(n) scan all keys for a prefix
        `-- collectRows()      O(n) group every cell by rowId

After: each layer owns one responsibility
TableHelper (schema validation, typed CRUD, branded ids)
  `-- RowStore (in-memory index: O(1) has/count, O(m) get)
        `-- CellStore (key parsing, typed change events)
              `-- YKeyValueLww (generic LWW conflict resolution)
```

Use `` `-- `` for a single child and `` |-- `` when siblings exist. The before and after pair makes the win visible at a glance.

## File Relocation Tree

When files move between directories and the move itself is the architectural statement, show the move. This is not "listing changed files," which the skill forbids; it is showing the reorganization.

```txt
packages/epicenter/src/
  shared/
    y-cell-store.ts   ->  dynamic/tables/y-cell-store.ts
    y-row-store.ts    ->  dynamic/tables/y-row-store.ts
  dynamic/tables/
    table-helper.ts       (refactored to compose over the above)
```

Use when two to six files move and the new location communicates intent (these belong to the tables subsystem, not shared). Do not use for same-directory renames or moves that are incidental to the real change.

## Layered Architecture

When components stack, show them from high-level to low-level with a one-line job per layer. Keep it to a thin form; full boxes are rarely worth it.

```txt
defineStore({ id, tables, kv })       declare and validate the schema
  await openPersonal(definition, { account })  acquire a ready store
    store.tables / store.kv / store.blobs     use store-owned data
```

## Comparison Table

When the PR weighs approaches, a small table beats paragraphs.

```txt
Use case                        Recommendation
real-time collab, simple        YKeyValue (positional)
offline-first, multi-device     YKeyValueLww (timestamp)
clock sync unreliable           YKeyValue (no clock dependency)
```

## Flow And Protocol

For data or control flow, use an arrow chain. For a wire format, show the field layout inline so the reader can read bytes left to right.

```txt
client action
  -> runtime adapter
  -> shared action map
  -> table mutation
```

```txt
REQUEST:  [101] [0=REQ] [requestId] [targetClientId] [action] [jsonInput]
RESPONSE: [101] [1=RES] [requestId] [requesterClientId]       [jsonResult]
```

## Dependency Edge

When a file is split out specifically to break a cycle, show the edge so the reviewer sees why the split exists.

```txt
token-store.ts        (standalone, imported by both)
  ^              ^
  |              |
auth/index.ts    workspace/client.ts
```

## Journey / Evolution

When a PR corrects or iterates on earlier work, show the progression so the reader sees why the latest step is right. Prefer a light arrow chain over stacked boxes.

```txt
PR #1217  Add YKeyValue for 1935x storage win
   -> PR #1226  Remove YKeyValue, cite "unpredictable LWW"   (!) misleading
   -> this PR   Restore YKeyValue with LWW timestamps: latest write wins, intuitively
```

Use when the history explains the change. Skip it for first-time work. Mark a misleading prior claim with a plain `(!)` and a short label rather than an emoji.

## ASCII Palette

Box and arrow characters that render cleanly in GitHub markdown:

```txt
┌ ┐ └ ┘ ─ │ ├ ┤ ┬ ┴ ┼ ▼ ▲ → ←
```

In trees and flows, prefer the plain ASCII forms `` |-- ``, `` `-- ``, and `->`; they are easier to type and diff. Reserve the box-drawing set for the rare genuine multi-box architecture diagram.
