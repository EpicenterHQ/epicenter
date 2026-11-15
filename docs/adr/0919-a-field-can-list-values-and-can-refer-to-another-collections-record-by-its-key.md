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
- The target has exactly one placeholder.
- A collection that refers to itself, or two that refer to each other, pass a
  function: `field.ref(() => pages)`.
- `create`, `set`, and `update` refuse a key that has no record in the target.
- A read returns the key and reads no other file.
  `collections.at({ collection: key })` follows it.
- In an action's `input`, `field.ref(pages)` checks the key's form. The action
  finds out whether the record exists when it reads it.

**The schema says what a reference points at, and the annotation never changes the value.**

A reference's JSON Schema is `{ "type": "string", "x-epicenter-ref": { "path": "data/collections/{collection}.md" } }`.
A reader that ignores `x-epicenter-ref` still holds a correct string. An
`x-epicenter-*` key is used only where JSON Schema has no keyword, and it may
add meaning to a value but never stand for a value of another type.

## Consequences

- A page can draw a picker for a reference and chips for a list of them from
  the schema alone. The app's listing names the action that lists the target
  when the app exposes one; a page with none falls back to a text box.
- A record must exist before another names it. Two records that name each
  other are written in two steps.
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
