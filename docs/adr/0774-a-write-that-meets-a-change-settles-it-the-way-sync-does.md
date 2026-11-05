# 0774. A write that meets a change settles it the way sync does

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at "every update or delete passes `over`, the version it read" and the refusal `Conflict { current }`: no write takes a version and none answers `Conflict`; [ADR-0769](0769-svelte-reads-every-capability-through-one-reactive-copy.md) at the folder's writes "made over the version shown": the folder settles a write that meets a change; [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) at "the folder then carries the person's edit over the change (`updateNote`)": it settles it with `settle`.
- **Relates:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (one merge for a save and for sync, which this returns to), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (the later write to an attachment wins), [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (no history before the first sync).
- **Unbuilt:** all of it: the folder calling `settle` when a store answers `stale`; removing `over`, `base`, `version` and `Conflict` from the folder's API and from `@epicenter/definition`'s client types; an editor settling the whole text it began from; Capture's text editor and `note-repair` on that editor; one content name per file on every store.

## Context

Any program can change a file between the moment a writer reads it and the
moment it writes, and plain files have no lock other programs honor. The
only way not to destroy a change the writer never saw is to compare what is
there with what was read, just before writing: the file's version. That
comparison cannot go; nothing else on plain files can do its job.

What it does after the comparison was two rules. Sync settled two writes
with `settle` (`@epicenter/definition/merge`, and its Rust twin): each
front-matter key takes the later write, the body merges by lines and keeps
an overlap as a conflict block, a binary takes the later write, and an edit
beats a delete. A write inside an app instead answered `Conflict` when the
same field or text had changed, so every caller that replaced text kept a
version and showed a refusal (Capture's text editor, `note-repair`), and
the folder carried a patch over other fields' changes with `updateNote`.
The same two edits came out one way through an app and another through
sync. The desktop app runs `epicenter sync --watch` for as long as it runs,
so a change is committed within a round of it.

## Decision

**Every write that meets a change settles it with `settle`, on the
writer's computer.** When a store answers that a file changed since it was
read, the folder settles what was read, what is there, and what is being
written, and writes the result over what is there, trying again if it moves
once more. A key both changed takes this write's value; a body both changed
merges by lines, and an overlap becomes a conflict block in it; a binary
takes this write; an edit made since beats this delete, so the file stays
with that edit. An app and sync now settle the same two edits the same way.

**No write answers `Conflict`, and none takes a version.** `update`,
`replace`, and `delete` take no `over` or `base`, and an entry an app reads
carries no `version`. The folder keeps what it read of each path, and an
editor keeps the text it began from, which is what `settle` merges against.
A create still answers `Occupied` where a file is, and a change to nothing
answers `NotFound`: those are facts about the path, not two writes meeting.

**A value that loses stays in history once it was committed.** After its
first sync a folder is committed each round while the Epicenter app runs, so
a key's earlier value is in history unless both writes landed inside one
round. People keep what fields mean as the latest value, as every tool with
properties does; their prose is never lost, because a body merges or holds
both sides.

**A version is the name Git gives the content,** the blob id of a note and
the Git LFS object id of any other file, on every store. It is internal, so
its form can change without touching an app.

## Consequences

- One rule for two writes meeting, in apps and in sync; what an app shows
  after a race is what sync would have made.
- `Conflict`, `over`, `base`, and `version` leave the API; Capture's text
  editor and `note-repair` lose their refusal screens and version
  bookkeeping, and `updateNote` gives way to `settle`.
- Within one round on one computer, a key's losing value is gone; a body
  never loses either side.
- A delete of a note changed since it was shown does not delete it; the
  folder shows the note with that change.
- `settle` has two implementations, TypeScript and Rust, held to the same
  cases.
