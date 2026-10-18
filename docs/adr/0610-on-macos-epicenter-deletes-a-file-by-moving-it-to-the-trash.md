# 0610. On macOS, Epicenter deletes a file by moving it to the Trash

- **Status:** Accepted
- **Date:** 2026-10-18
- **Amends:** [ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md) at the consequence "Files a folder's `.gitignore` ignores, such as Whispering's audio (ADR-0592), and changes not yet committed are gone once a page deletes them, since a storage deletion keeps no copy": on the desktop a deleted file goes to the macOS Trash, and in a browser tab a deletion stays permanent.
- **Relates:** [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) (installing trusts the author fully), [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) (principle 4: mistakes are left to Git), [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) (what a folder ignores).
- **Unbuilt:** all of it: `storage::put` with no bytes moving the file to the Trash instead of `fs::remove_file` (`packages/tauri-plugin-epicenter-folder/core/src/storage.rs:658` at `e9027cc744`), and the Bun opener's file removal (`remove` in `packages/folder/src/directory-node.ts:108-113`, called from `packages/folder/src/directory-store.ts:192`) doing the same on macOS.

## Context

A desktop page deletes a file through the shell's storage command:
`storage::put` with no bytes (`packages/tauri-plugin-epicenter-folder/core/src/storage.rs:618`)
checks that the file still holds what the page expects and calls
`fs::remove_file` (`:658`). The CLI's Bun opener, which agents run, removes
a file with `rm` (`remove` in `packages/folder/src/directory-node.ts:108-113`).
Neither keeps a copy. Git restores a committed file; a file a folder's
`.gitignore` ignores, such as Whispering's audio (ADR-0592), and any
uncommitted change are gone.

[ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md)
removes the fence that kept an app's page to one folder, so one app's page
can delete another app's files, and it states that loss as its cost.

## Decision

**On macOS, Epicenter never permanently removes a file it deletes from a
data folder: deleting one moves it to the person's Trash.**

```txt
deletion through                                 today               decided
storage::put with no bytes (a desktop page)      fs::remove_file     moved to the Trash
remove in directory-node.ts (the CLI, agents)    rm                  moved to the Trash
rmdir (storage.rs:427)                           an empty directory  unchanged: it holds nothing
removeEntry in a browser tab (OPFS)              permanent           unchanged: OPFS has no Trash
```

- The move is the system's own (`NSFileManager`'s
  `trashItemAtURL:resultingItemURL:error:`), so the file appears in the
  Trash the person already uses, under its own name.
- The check before a deletion is unchanged: the file moves only while it
  holds what the caller expects (`if_match`).
- When the move fails, the deletion fails and the file stays where it was.
  Nothing falls back to removing it.

**So on the desktop every deletion, though not every overwrite, is
repairable: a committed file from Git, any other file from the Trash.**
That is what makes removing the fence between apps (ADR-0607) safe against
a mistaken deletion.

**In a browser tab a deletion stays permanent.** OPFS has no Trash; a tab
recovers only what its folder had committed.

**Neither covers exfiltration.** An installed app reads every folder and
reaches the network, and installing trusts its author fully (ADR-0605).

## Consequences

- A write is not a deletion: a write that replaces a file's bytes keeps no
  copy of the old ones, so an uncommitted change or an ignored file that a
  page overwrites is still lost.
- The Trash grows by every file Epicenter deletes, and holds it until the
  person empties the Trash or macOS removes it after 30 days, when "Remove
  items from the Trash after 30 days" is on.
- A deletion that Git performs, such as a merge or checkout run by the
  CLI's system `git`, goes through Git, not through these calls; the file is
  in the folder's history.
- Windows and Linux, unbuilt for installed apps (ADR-0605), need the same
  rule from their own trash before they ship.

## Considered alternatives

- **Keep the fence (ADR-0586).** It stops a page, not the author's build,
  which runs as the person (ADR-0607).
- **An Epicenter trash directory, in app data or in each folder.** It is a
  second place the person has to know about, and one inside a folder would
  sync unless every `.gitignore` named it.
- **Commit before every deletion.** It adds a commit per deletion to the
  folder's history and still loses an ignored file.
