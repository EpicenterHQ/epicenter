# 0922. A read gives only what the file holds, and no field has a default

- **Status:** Proposed
- **Date:** 2026-11-15
- **Unbuilt:** all of it. `project` in `packages/app/src/collection.ts` still puts a field's default in place of a value that does not fit, `add` still writes defaults into a new file, and `defineAction` still fills input with `Value.Default`.

## Context

A read of a collection gave each field as its value when the value fit, else
the field's default, else absent. Two helpers carried a default: an absent
`field.boolean()` read `false` and an absent list read `[]`. A raw TypeBox
schema could carry any other.

That rule made a read show a value the file did not hold:

- A file with `tags: a, b` read as `tags: []`, with a problem line. A
  computed write that appended to it, `set(keys, (now) => ({ tags:
  [...now.tags, 'new'] }))`, then wrote `["new"]`, and the person's value was
  gone.
- A watch with `paused: "yes"` read as `paused: false` and was still
  researched.
- `add` wrote each default into the new file, which a file made by hand
  never has.

A default given to a helper that did not declare the option was dropped
without a word: `field.integer({ default: 50, min: 1 })` returned
`{ "type": "integer", "minimum": 1 }`. Codex declares three such inputs, and
each is required from the command line and from an agent. No collection in
the apps declares a default of its own; apps that want one write it where
the value is read: `limit ?? 50`.

## Decision

**A value that does not fit its field reads as absent, with a problem line. Nothing takes its place.**

**When a field's key is not in the file, a switch reads `false`, a list reads `[]`, and every other field is absent.**

That is what `field.boolean()` and `field.list()` mean, not a default a
schema carries. Neither value is written unless a caller gives it: `add`
writes what it was given and nothing more.

**No schema carries `default`.**

`defineCollection` and `defineAction` throw when a field's schema has a
`default` key at any depth, and say to write the default where the value is
read. A field helper given an option it does not declare throws, naming the
option. `defineAction` fills an absent switch with `false` and an absent list
with `[]` before `run`, by the same rule as a read.

**A change computed by a function may not write a field whose current value did not fit.**

`set(keys, fn)` and `update(keys, fn)` throw `ActionError.Refused`, naming
the path and the field, and write nothing. Plain data may write that field,
which is how it is repaired.

**A record without `problems` has its required fields.**

So `!record.problems` is the check that makes a required field safe to use.

## Consequences

- A record read from a file is a statement about that file. Code that used a
  filled value for a field with a problem now sees it absent and must decide.
- Three inputs in Codex stop being silently required: the definition throws
  until the default moves into the code that reads `limit`.
- The types that told a field with a default from one without go, with the
  rule that a one-file collection's required field needs a default
  ([ADR-0917](0917-a-collection-selects-a-record-by-its-keys-and-a-file-that-is-not-there-reads-as-absent.md)).
- A function that reads a list it means to append to must first see a record
  with no problem in that field, or the write is refused.
- A new file holds only what its maker gave. Two files made by the app and
  by hand with the same content are the same bytes.

## Considered alternatives

- **Keep defaults in action input only.** An app passes a collection's field
  into an input, so a schema legal in one place and refused in the other is
  worse than one rule.
- **Fill nothing, switches and lists included.** Every reader would write
  `?? false` and `?? []` for the two kinds whose absence has one meaning.
- **Keep the fill and return the raw value beside it.** A reader that does
  not look still acts on a value the file does not hold.
