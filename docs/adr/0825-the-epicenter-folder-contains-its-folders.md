# 0825. The Epicenter folder contains its folders

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Amends:** [ADR-0815](0815-the-platform-gives-a-window-its-folder-and-every-app-the-same-home.md) at "Discovery lists `~/Epicenter` and follows links": Epicenter syncs the real directories in it, and shows a link as outside it; [ADR-0736](0736-a-folder-outside-the-library-is-enrolled-through-a-link-the-person-names.md) at a folder outside joining through a link: a folder moves in, and a link outside reaches it; [ADR-0822](0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md) at a Git working tree found above a link's target and at detecting file-sync services per folder: Git owns a folder with `.git` at its root, and only the Epicenter folder is checked for a file-sync service.
- **Relates:** [ADR-0821](0821-a-computer-remembers-what-it-synced-and-a-shell-limits-each-window-to-its-folder.md) (identity by inode and birth time).

## Context

Discovery followed links, so a folder in the Epicenter folder could live in
another Git repository, inside a file-sync service, or on another volume with
its own file system. Each such place brought its own rules into Epicenter: a
search for `.git` above a link's target (and where that search should stop,
since a repository in the home directory would claim every linked folder),
file-sync detection per folder, identity on file systems without birth times,
and saves across volumes. The Epicenter folder's location is fixed, and it
already may not sit inside a file-sync service.

## Decision

**Epicenter syncs the real directories in the Epicenter folder, and nothing
else.** A link there is shown as outside the Epicenter folder and is never
synced; apps may still open what it points to. To keep a folder reachable at
another path, the folder moves into the Epicenter folder and a link at the
other path points to it.

**A folder with `.git` at its root belongs to Git.** Epicenter shows it as kept
by Git and never syncs it. When the Epicenter folder is itself a Git
repository, Epicenter says so once.

**Only the Epicenter folder is checked for a file-sync service**, and Epicenter
refuses to sync while it sits in one.

## Consequences

- Everything Epicenter syncs is on one volume, the home volume, where every
  directory has a birth time on macOS.
- The rules for linked folders, Git repositories above them, and file-sync
  services per folder go away.
- A folder that must stay on another drive is not synced.
