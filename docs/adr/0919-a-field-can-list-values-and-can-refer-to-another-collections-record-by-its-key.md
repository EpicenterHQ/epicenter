# 0919. A field can list values and can refer to another collection's record by its key

- **Status:** Proposed
- **Date:** 2026-11-15
- **Unbuilt:** all of it. `field` in `packages/app/src/field.ts` has `tags` and no `list` or `ref`.

## Context

`field.tags()` is the one list field: an optional list of text that reads as
empty when absent and takes `--name a --name b` on the command line. A list of
anything else is written in TypeBox by hand and gets neither behavior.

A record also points at other records, and nothing says so. A page's front
matter holds `collections: ["essays"]`, naming files in `data/collections/`.
An action that takes a record declares `page: field.text()`. In both, the
value is checked as text and never against the collection it names.

## Decision

**`field.list(item)` is a list of any field.**

It is optional, reads as `[]` when the line is absent, and takes a repeated
flag on the command line. `item` is any field:

| Written | Means | On disk |
| --- | --- | --- |
| `field.list(field.text())` | free tags | `tags: ["a","b"]` |
| `field.list(field.select(['x', 'threads']))` | several of a fixed set | `platforms: ["x","threads"]` |
| `field.list(field.ref(collections))` | several records | `collections: ["essays"]` |

`field.tags()` is removed. `field.list(field.text())` is the same field.

**`field.ref(collection)` is the key of a record in another collection, stored as that key.**

```ts
const pages = defineCollection({
  path: 'data/pages/{page}/page.md',
  fields: { collections: field.list(field.ref(collections)) },
});
```

- The value is text. On disk it is the target's key and nothing else:
  `"essays"`, never a path and never `collections/essays`.
- The target has exactly one placeholder, is not a `.local` collection, and is
  declared before the collection that refers to it.
- `add` and `set` refuse a key that has no record in the target, and a key
  that is not exactly the one the target's file carries, so `" essays "` is
  refused. `update` does not check: its value comes from the app's own
  function, as a `readOnly` field's does.
- A read returns the key and reads no other file. The target's own `get`
  follows it.
- In an action's `input`, `field.ref(pages)` checks the key's form. The action
  finds out whether the record exists when it reads it.

**The schema says what a reference points at, and the annotation never changes the value.**

A reference's JSON Schema is `{ "type": "string", "x-epicenter-ref": { "path": "data/collections/{collection}.md" } }`.
A reader that ignores `x-epicenter-ref` still holds a correct string. An
`x-epicenter-*` key is used only where JSON Schema has no keyword, and it may
add meaning to a value but never stand for a value of another type.

## Consequences

- A reader of the schema can tell a reference from free text, and a list of
  them from a list of tags. Which action lists a reference's target is not in
  the schema; a page that draws a picker names that action itself.
- A record must exist before another names it.
- A collection cannot refer to itself, and two cannot refer to each other.
  Such a field stays `field.text()` until an app needs it checked.
- Renaming a record leaves the keys that named it pointing at nothing.
  `epicenter check` reports them
  ([ADR-0920](0920-epicenter-check-reports-every-record-that-does-not-fit-its-collection.md)).
  Nothing rewrites them.
- A list of objects is `field.list(Type.Object({ ... }))`, with TypeBox's own
  `Type.Object`. It cannot be given as command-line flags and goes in as JSON.
- 13 `field.tags()` calls in the apps become `field.list(field.text())`.

## Considered alternatives

- **Store the target's path.** It writes the folder layout into every record,
  so moving a folder breaks data.
- **Store `collections/essays`.** The field already says which collection, so
  the prefix repeats it in every value. It is worth adding only for a field
  that may point at two collections.
- **A separate multi-select helper.** `field.list(field.select(...))` is the
  same thing.
- **Check a reference on every read.** A read would open a second file for
  each reference. The write and the check command cover it.
- **`field.object`.** It would rename `Type.Object` and add nothing.
- **A function target, `field.ref(() => pages)`, for self-references and
  cycles.** Built and removed. The annotation had to stay empty until
  `defineApp` resolved it, which took a hidden resolver, a walk of every
  schema, and a dependence on how TypeBox copies a schema. TypeScript also
  needs a return type written on the function. No app has such a field.
- **Check references inside `update`.** Built and removed. The value is only
  known inside the write's own callback, which cannot wait for a read, so the
  check threw out of the callback, read, and ran it again.
- **The app listing names the action that lists a reference's target.** Built
  and removed. It needed a mark on every generated verb, and no page reads it.
