# 0228. A field is one value, and a collection several devices append to is a table

- **Status:** Accepted
- **Date:** 2026-08-09
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Relates:** [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md)
  (a row is a Yjs type and a field is an attribute on it),
  [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  (a Lens is pure JSON),
  [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md).
<!-- doc-path-check: ignore-next-line -->
- Evidence: measured in `docs/the-store-and-what-it-replaced.md`, "What
  granularity an edit actually has".

## Context

Merging in this store happens at three levels, and only two of them were ever
decided on purpose. Two devices editing different fields of one row both keep
their edit, because a field is its own attribute. Two devices editing one scalar
converge on a winner. Prose in a row document merges per character.

The third level was inherited rather than chosen: an array or object field is a
single JSON value in a single attribute, so two devices each appending to it
converge on one of them and the other addition is gone. Measured:

```txt
phone:  tags: ['a', 'from-phone']
laptop: tags: ['a', 'from-laptop']
after sync -> ['a', 'from-phone']
```

Nothing is corrupt and both devices agree. Someone's tag is simply missing.

The obvious response is a per-field CRDT type system: array fields that merge as
sequences, counters that add, maps that deep-merge, and a Lens syntax rich
enough to declare which.

## Decision

**Refused. A field is one value, and one value is replaced wholesale.** There is
exactly one merge rule for every scalar, array and object a Lens can declare,
and it fits on a line.

**A collection several devices append to concurrently is a table, not a field.**
The store already has a per-element merge primitive and it is a row: elements
written independently do not collide, deletion is a real operation rather than
an array splice that races, and each element gets an id that something else can
reference.

The guidance authors need is a question, not a warning. Who writes this
collection? One device at a time, or one place in the UI, and an array field is
right. Several devices concurrently, each adding their own element, and it is a
table.

## Consequences

The Lens vocabulary stays small. A per-field merge system would mean a second
semantics to learn per field kind, a declaration syntax to carry it, and a new
way for two releases to disagree — not about a field's value, but about what
kind of thing the field IS. Refusing it keeps "a field is one value" true of
every field forever.

**The cost is real and paid by a narrow class of field.** A set that several
devices append to concurrently will lose an addition, silently, with both
devices agreeing afterwards. Whispering's `dictionary` is exactly that shape and
is the first thing to look at under this rule.

It composes with the healing story rather than fighting it. A lost append is
not a nonconforming row; it is a converged value that is missing something, so
nothing surfaces it and nothing can. That is the honest reason to move such a
collection to a table rather than to document the hazard and hope.

Nothing here changes prose. Per-character merging lives in a row document, which
is a different plane from a field and stays exactly as it was (ADR-0215).
