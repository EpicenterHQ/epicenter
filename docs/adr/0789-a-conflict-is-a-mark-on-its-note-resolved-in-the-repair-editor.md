# 0789. A conflict is a mark on its note, resolved in the repair editor

- **Status:** Superseded
- **Date:** 2026-11-05
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0788](0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md) at the marks a person sees, synced and waiting: a note holding a conflict block also shows ⚠.
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (a body changed at the same spot on both sides becomes one conflict block of whole lines), [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) (a write settles the way sync does), [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) (a note that does not read is repaired as text).
- **Amended by:** [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) at the markers `settle` writes: a conflict is Git's markers, with fixed labels.
- **Unbuilt:** all of it: the folder reporting which notes hold a conflict block; the ⚠ mark in each app and in the library; `NoteRepair` showing a conflicted note's two versions and saving the resolved text.

## Context

`settle` keeps both sides of a body edited at the same spot as one conflict
block of whole lines, between Git's markers (`<<<<<<< current`, `=======`,
`>>>>>>> incoming`, written by `packages/definition/src/merge/conflict.ts`).
The note still reads, so nothing points a person at the block: it is text
they find by chance, while an agent sees the markers Git tools know.

## Decision

**A note holding a conflict block shows ⚠, and its repair editor resolves
it.** Whether a note holds one is read from its text, by the markers
`settle` writes; nothing is stored. The note stays in its collection and
shows as usual, with ⚠ beside it. Opening it shows its whole text in the
repair editor (`NoteRepair`) with both versions in place, and saving text
with no block resolves the conflict; the save is an ordinary edit, settled
and synced like any other.

## Consequences

- A conflict is found where the note is, in its app and in the library, and
  needs no merge screen.
- Agents and people see the same block in the same text.
- A note that quotes a whole block in `settle`'s exact form, labels
  included, shows ⚠ too; that is rare enough to accept.

## Considered alternatives

- **The block as plain text, with no mark:** nothing to build, and a person
  rarely finds it.
- **A merge view with keep mine, keep theirs, or both per block:** friendlier
  for a block or two, and a second editor beside the repair editor every
  app already has.
