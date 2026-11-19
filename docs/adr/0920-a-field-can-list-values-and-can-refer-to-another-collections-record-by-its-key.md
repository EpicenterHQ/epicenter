# 0920. A field can list values and can refer to another collection's record by its key

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-15

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

It is never required and reads as `[]` when the line is absent. Its schema is
an array with one annotation, `"x-epicenter-field": "list"`, which is what
says so. `item` is any field:

| Written | Means | On disk |
| --- | --- | --- |
| `field.list(field.text())` | free tags | `tags: ["a","b"]` |
| `field.list(field.select(['x', 'threads']))` | several of a fixed set | `platforms: ["x","threads"]` |
| `field.list(field.ref(collections))` | several records | `collections: ["essays"]` |

`field.tags()` is removed. `field.list(field.text())` is the same field.

`field.list(item, { min: 1 })` is a list that needs at least that many. It
is required like any other field, its schema carries `minItems`, and an
absent one is a missing field, since `[]` would not fit. Most lists take no
`min`: in a record, having none is the usual state. An action that cannot
run without one says so in its schema, where an agent reads it.

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
- `add` and `set` given plain data accept a key when the target's `get`
  finds a record and that record's key is exactly the value given. So a file
  named by hand `Dune  Messiah.md` can be referred to by that name, and
  `" essays "` is refused, saying to write `"essays"`. A change computed by a
  function is not checked: its value is the app's own, as a `readOnly`
  field's is.
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
  ([ADR-0921](0921-epicenter-check-reports-every-record-that-does-not-fit-its-collection.md)).
  Nothing rewrites them.
- A list of objects is `field.list(Type.Object({ ... }))`, with TypeBox's own
  `Type.Object`. The apps do not have TypeBox installed, so none declares one.
- The `field.tags()` calls in the apps became `field.list(field.text())`.
  Finance names its accounts, institutions, and sources with `field.ref`.

## Considered alternatives

- **Store the target's path.** It writes the folder layout into every record,
  so moving a folder breaks data.
- **Store `collections/essays`.** The field already says which collection, so
  the prefix repeats it in every value. It is worth adding only for a field
  that may point at two collections.
- **A separate multi-select helper.** `field.list(field.select(...))` is the
  same thing.
- **Check a reference on every read.** A read would open a second file for
  each reference. `add` and plain-data `set` validate the references they
  write. Reporting absent targets in the check command remains unbuilt.
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

## Amendment (2026-11-18): a list is required unless it says optional; refs are checked when defineData runs

A list follows ADR-0923's amendment of the same date: like every field it is
required unless it says `optional: true`, and an absent one is absent, never
`[]`. `min` bounds its length when it is given. `defineData` still refuses a
`field.ref` whose target is not one of its keys, when it runs; the types no
longer check the target, so `field.ref` takes any text as its target.

## Amendment (2026-11-18): a write checks the refs it sets, and nothing checks them again

`create`, `patch`, and `edit` refuse a write that changes a `field.ref` to an
id that is not one of the ids the target key's `list` reads, including each
item of a list: a `Misfit` naming the field, the key, and the id, such as
`watch "sfo-bos" names no record in watches`, with nothing written. An absent
optional ref and `null` pass, and so does a ref the record already holds.
`defineData` refuses a ref anywhere but a field or a list's item, so every
ref it accepts is one a write checks. This applies to a change computed by
`edit`'s function too: the check runs inside the write, after the function
returns, with a synchronous listing, so the callback runs once (the reason
"check references inside `update`" was removed above was an asynchronous
read).

A ref is checked once, when it is set, by the rule that each thing is
checked once, where it can change, recorded in
[ADR 0968](0968-each-thing-is-checked-once-where-it-can-change-and-epicenter-check-is-deleted.md). A delete or rename of the target, or a hand
edit, leaves it naming nothing until code that follows it reads the target;
"`epicenter check` reports them" in the consequences above no longer holds.
The cost is one listing of each target key a write changes a ref into. Inside one serve, a write
sees every write that finished before it; a target being created by another
process at the same moment may be missed, and the write is refused.
