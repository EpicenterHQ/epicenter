# 0571. Applications keep no last-edited timestamp in a row

- **Status:** Proposed
- **Date:** 2026-10-16
- **Relates:** [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (unknown keys are kept), [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md), [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) (a save names what of the other side it replaced)
- **Unbuilt:** removing `updatedAt` from Honeycrisp's `notes` table and note creation; deleting `withBody`; sorting and grouping `NoteList` by `createdAt`; deleting the `updatedAt` exception in Honeycrisp's save notices.

## Context

Honeycrisp's `notes` table declares `updatedAt` (`apps/honeycrisp/src/lib/data.ts`).
`withBody` (`apps/honeycrisp/src/lib/note-source.ts`) moves it forward on every
body change, and `NoteList.svelte` sorts notes by it and groups them under
labels such as "Today" and "Yesterday".

Only Honeycrisp moves the field. A note edited by an agent, another editor, or
a Sync keeps its old `updatedAt`, so the order is wrong for any change made
outside the app. Every save also changes a second line of the file, and when
two sides both edit a note, both moved `updatedAt`. Honeycrisp already filters
that field out of the values a save reports replacing
(`apps/honeycrisp/src/lib/notes.svelte.ts`: "Both sides moving `updatedAt` is
not a change worth a notice").

## Decision

**An application does not move a timestamp field forward when it saves a
row.** A field written once at creation, such as `createdAt`, stays. A value
computed in memory, such as Vocab's chat `updatedAt` derived from its
messages, is not a row field and is unaffected.

In Honeycrisp:

- `updatedAt` is removed from the `notes` table and from note creation.
  Existing files keep their `updatedAt` line, because unknown keys are kept
  (ADR-0518).
- `withBody` is deleted. A body edit sends the body alone.
- `NoteList` sorts newest first by `createdAt` and groups by `createdAt`.
- The `updatedAt` exception in the save notices is deleted.

When a file last changed belongs to the file system and Git. A "recently
edited" order may return later from file modification time.

## Consequences

- Honeycrisp's list orders notes by when they were created, not when they
  were last edited. Someone used to Apple Notes' "date edited" order will
  notice.
- A save changes only what the person changed, so a concurrent edit no longer
  overlaps on a field neither person touched.
- Every editing app's body edit is the same, with no app-specific wrapper.

## Considered alternatives

- **File modification time now.** It is correct for changes made outside the
  app, but it needs a new folder contract, and a Git checkout or Sync resets
  it, so every pulled note would look edited just now.
- **Last commit time.** Commits happen only on Sync or "Save version"
  (ADR-0529), so the groups would be stale.
