# 0774. One write makes it so, and settles a change the way sync does

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at the client's `create`, `update` and `delete`, "every update or delete passes `over`, the version it read", and the refusals `NotFound`, `Occupied` and `Conflict { current }`: one write, `set`, takes no version, and a write fails only as `Invalid` or `Unavailable`; [ADR-0769](0769-svelte-reads-every-capability-through-one-reactive-copy.md) at the folder's writes "made over the version shown": the folder reads a file just before writing it and settles a change; [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) at "the folder then carries the person's edit over the change (`updateNote`)": it settles it with `settle`.
- **Relates:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (one merge for a save and for sync, which this returns to), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (the later write to an attachment wins), [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) (no history before the first sync).
- **Amended by:** [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) at "A write fails only as `Invalid` or `Unavailable`": a write never fails; the folder keeps it until it lands.
- **Amended by:** [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at a folder committed "while the Epicenter app runs" and at `append`: a folder is committed at each round its app runs, and no store appends.
- **Amended by:** [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) at `settle` having two implementations: it has one.
- **Amended by:** [ADR-0794](0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md) at a file other than a note named by its Git LFS object id: a store names it by a stamp, with the object id beside it.
- **Unbuilt:** one content name per file on every store: device stores still name a note by the sha256 of its bytes, since the desktop shell's checked writes compare sha256 (a non-note file's sha256 is already its Git LFS object id). The version stays internal to the folder, so this changes no app.

## Context

Any program can change a file between the moment a writer reads it and the
moment it writes, and plain files have no lock other programs honor. The
only way not to destroy a change the writer never saw is to compare what is
there with what was read, just before writing: the file's version. That
comparison cannot go. A modification time cannot stand in for it: two
writes in one second, a copy that keeps the time, or an editor that resets
it each miss a change, and a miss is a silent overwrite. The time stays only
as a listing's hint that a file may have changed.

Around that comparison, apps had three writes and five refusals. `create`
answered `Occupied` where a file was, `update` and `delete` answered
`NotFound` where none was and `Conflict` when the file had changed since the
version the caller passed back, and `replace` wrote a note's whole text the
same way. Sync settled the same two edits differently, with `settle`
(`@epicenter/definition/merge`, and its Rust twin): each front-matter key
takes the later write, the body merges by lines and keeps an overlap as a
conflict block, a binary takes the later write, and an edit beats a delete.
Callers held versions they never needed (the folder knows what it showed),
showed refusal screens (Capture's text editor, `note-repair`), and worked
around refusals that meant nothing to them: the conversation answered a
lost reply's `Occupied` by checking the note it found held its message.
Only Vocab's add meant `Occupied`: add a word without touching one already
there. The desktop app runs `epicenter sync --watch` for as long as it runs,
so a change is committed within a round of it.

## Decision

**There is one write: `set` makes it so.** `set(args, changes)` gives the
note those fields, and the body if given, creating it where nothing is; the
fields not named stay as they are. On a file collection,
`set(args, bytes)` writes the file. `delete(args)` removes a file, and one
already gone is gone. `edit(args)` is the editor for typing, over fields,
the body, or the note's whole text. `append` stays on a file collection
whose store has it.

```ts
folder.todos.set({ id }, { done: true });
folder.todos.delete({ id });
const note = folder.todos.edit({ id });
folder.audio.set({ id, ext: 'webm' }, bytes);
```

**A write reads the file just before writing it.** The folder reads what is
there, applies the change, and writes over exactly what it read. When the
file moves in between, it reads and applies again: the named fields take
this write, and everything else stays as the other writer left it. A body
or whole text the write replaces is settled with `settle` against what the
folder showed when the change began, so prose is merged, never overwritten.
An app and sync settle the same two edits the same way.

**A write fails only as `Invalid` or `Unavailable`.** Invalid: the change
does not fit the contract. Unavailable: the folder could not be reached.
No write takes a version and none answers `NotFound`, `Occupied`, or
`Conflict`; an entry an app reads carries no `version`. A delete of a note
changed since it was shown keeps the note with that change, as sync does.

**A field is a value people replace; a body is text people edit in parts.**
A key both changed takes the later write, with no finer merge for lists. A
key's losing value stays in history once committed: after its first sync a
folder is committed each round while the Epicenter app runs, so only two
writes inside one round lose a value. A body never loses either side.

**A version is the name Git gives the content,** the blob id of a note and
the Git LFS object id of any other file, on every store. It is internal, so
its form can change without touching an app.

## Consequences

- Writes go from `create`, `update`, `replace` and `delete` with five
  refusals to `set` and `delete` with two. Capture's text editor and
  `note-repair` lose their refusal screens; the conversation's check of a
  lost reply goes; `updateNote` gives way to `settle`.
- Vocab adds a word only after `get` shows none; a word added on two
  computers in one round resets its stage to the later add's.
- A `set` with a mistyped id makes a stray note instead of failing.
- What an app shows after a race is what sync would have made.
- `settle` has two implementations, TypeScript and Rust, held to the same
  cases.
