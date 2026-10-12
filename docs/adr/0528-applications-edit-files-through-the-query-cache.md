# 0528. Applications edit files through the query cache

- **Status:** Accepted
- **Date:** 2026-10-12
- **Supersedes:** [ADR-0515](0515-snapshot-saves-serialize-writes-and-retain-only-the-latest-pending-text.md) (snapshot autosave sessions) and [ADR-0523](0523-applications-own-drafts-in-edit-sessions-and-leave-one-open-item.md) (drafts in edit sessions, one open item)
- **Relates:** [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (reads, guarded writes, `InvalidRow`)
- **Unbuilt:** all of it. Todos is the first app to move; `edit-session`, `open-item`, `save-bar`, `autosave`, and the save merge (`table.merge`, `files.merge`, `save-merge.ts`) are deleted once all five apps have moved.

## Context

Each editing app kept a draft beside the file in an edit session, saved it
through an autosave queue, merged it with changes made elsewhere, and reread
its lists by hand after every action. The draft, the queue, the merge, the
conflict review, the open-item slot, and about thirty `refresh()` calls each
existed to keep a second copy of the files honest.

A local write answers in milliseconds, and a clash on save needs another writer
in that moment. Keeping a draft through a failed save protects at most what was
in flight, at the cost of all of that machinery.

## Decision

**The query cache holds the files, and an edit goes straight into it.**

- **Reads.** One TanStack query per table holds `table.list()`, built with
  `resultQueryOptions` from `wellcrafted/query`, so errors stay typed. A detail
  view reads the same query narrowed with `select`. An invalid row is an
  `Err(InvalidRow)` entry in that same listing.
- **When reads happen.** On open, on window focus, and after the app's own
  actions. Editing apps do not subscribe to file changes. No read starts
  while a write runs: an edit cancels reads in flight, the listing never goes
  stale on its own, focus does not refetch while writing, and the app rereads
  once the last write settles.
- **Edits.** One immutable `map` over the listing in the cache changes one row.
- **Writes.** Each edit is written with guarded `table.replace(stored, row)`
  from a mutation keyed and scoped by the file's path, so row writes, text
  writes, rename, and delete of one file run one at a time.
  The mutation reads the cache when it runs, so it saves the newest row and
  guards with the newest confirmed `sha256`. A file has at most one write
  running and one waiting: an edit queues a write only when none is waiting.
  `onSuccess` on the mutation options moves the guard forward and keeps the
  newest row; TanStack awaits it before the next write in the scope starts.
- **Failure.** A failed write reads that one file again, which rolls the row
  back, and a toast says what happened. A toast for discarded typing
  offers to copy the text.
- **Validity.** An input commits only a value the schema accepts: pickers and
  typed fields commit on Enter or blur. The folder keeps refusing invalid
  writes. A row made invalid outside the app is repaired as text through
  `files.replace`.
- **State.** `$state` holds only input that is not committed yet: a new-item
  box, a search, a typed field that does not parse yet.
- **Leaving and closing** wait for writes in flight and never ask to discard.
  Every app action is a mutation, so close waits until the mutation cache is
  idle; loading and outcome state for commit and sync come from mutation
  state.
- **Delete** warns when the file has changes that are in no saved version.

## Consequences

The edit session, the open-item slot, the save bar, the autosave queue, the
save merge, and every app's refresh and conflict wiring are deleted. A detail
view and a table edit rows the same way and cannot disagree.

A rejected edit rolls back instead of being kept, so a person can lose what
was in flight: one click or the last moment of typing. Nothing changes in
front of a person while they watch; outside changes appear on return or after
sync.

## Considered alternatives

- **A draft per editor, kept through failures.** Protects at most a second of
  typing, at the cost of a second copy of every open file, base tracking, a
  compare dialog, and a discard prompt.
- **Merge on save.** Rare clashes on save do not justify a merge path beside
  sync's.
- **Live subscription in every editing app.** Brings own-write echoes and
  mid-save races for updates no editing app needs.
- **A write per keystroke without coalescing.** Builds a queue of writes that
  all save the same text.
