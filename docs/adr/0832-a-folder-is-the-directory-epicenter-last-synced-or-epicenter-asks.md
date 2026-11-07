# 0832. A folder is the directory Epicenter last synced, or Epicenter asks

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Amends:** [ADR-0822](0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md) at a directory proven by its recorded name and exact files when the person is its only member, and at a folder held alone joining without asking: only the directory's own identity proves it, and anything else asks; [ADR-0821](0821-a-computer-remembers-what-it-synced-and-a-shell-limits-each-window-to-its-folder.md) at a directory rebinding by name when the Epicenter folder moved: it asks.
- **Relates:** [ADR-0825](0825-the-epicenter-folder-contains-its-folders.md) (the Epicenter folder contains its folders, on one volume).
- **Unbuilt:** removing the second proof, the check for a sole member, and joins by name; one question that lists every unbound folder.

## Context

A directory is proven to be a folder by its inode and birth time, which a copy
does not carry and a rename keeps. A second proof, the recorded name and
exactly the recorded files when the person is the folder's only member, existed
so that a move to a new computer, where every inode differs, would ask nothing.
It needed the server's member list at every check, a fallback for file systems
without birth times, and two review rounds to close the ways it could attach a
new private folder to a shared one of the same name. A new computer happens
rarely.

## Decision

**A folder is the directory Epicenter last synced**: one whose inode and birth
time match its record, both real. Epicenter follows a folder the way a Finder
alias does: renamed or moved within the Epicenter folder, it is the same folder;
copied, it is a new one. Every other directory is unbound and stays
local until the person answers one question listing every unbound folder at
once, each with the folders it may be (by name, title, or app) and their
members. After a move to a new computer, that question is "Reconnect these
folders?", once. Joining starts from first contact, which never deletes.

**An app's own folder joins as before**: an unbound folder with the name an app
gives its folder, held by the person alone, joins that app's folder.

## Consequences

- Copying, renaming, and restoring a folder behave as before.
- A new computer asks one question before it syncs.
- No rule infers a folder from its name and files, so none can attach a private
  folder to a shared one.
