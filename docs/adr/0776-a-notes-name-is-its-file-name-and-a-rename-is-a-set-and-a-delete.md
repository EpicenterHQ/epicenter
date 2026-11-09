# 0776. A note's name is its file name, and a rename is a set and a delete

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (a collection's path template, and naming a file to create it), [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) (`set` and `delete`), [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) (a name that would leave its collection throws), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (a repository is never renamed; a note may be).
- **Unbuilt:** nothing in the folder; an app that lets a person rename a note keeps the links to it current.

## Context

A collection's path template names its files by placeholders
(`todos/{id}.md`), and creating a file means naming it (decision 5). Apps
used `id` and filled it from `timeId()`, and Whispering's rules said ids are
identity and a note's file is never renamed, because results point at
recordings by id. A page in a vault is named by a person instead: its file
name is a stem made from its title, and people rename pages. Whether a name
may change was being decided as if every collection were Whispering's.

## Decision

**There are no ids, only file names.** A placeholder is part of a file
name, and an app chooses it: a stem from `timeId()` for a recording, a stem
from a person's title for a page. `id` is a placeholder's name, nothing more.

**A rename is a `set` at the new name and a `delete` of the old.** The
folder has no rename verb. Git records the pair as a rename because the
content matches, and sync follows renames (libgit2's rename detection in
`packages/epicenter-core/src/merge.rs`), so an edit on one computer and a
rename on another merge into the renamed file.

**A name others point at stays.** What links to a note by its name breaks
when the name changes. A collection whose notes are linked to by name keeps
their names, as Whispering's recordings do; a collection people name lets
them rename, and the app that renames updates the links to the note.

## Consequences

- No identity concept beyond the path; the folder needs no rename verb.
- A rename made on one computer while another edits the old name merges,
  where Git's rename detection pairs them; where it does not (the content
  changed too much), the edit keeps the old file beside the new one.
- Links by name are the app's to keep current.
