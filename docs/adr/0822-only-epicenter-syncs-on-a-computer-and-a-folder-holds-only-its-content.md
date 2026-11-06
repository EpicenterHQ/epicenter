# 0822. Only Epicenter syncs on a computer, and a folder holds only its content

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0819](0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md) at "Every program keeps the folders it has open in sync": on a computer only Epicenter's programs sync, and a web app syncs its own folder; [ADR-0785](0785-a-desktop-app-signs-in-to-sync-its-own-folder.md) at a desktop app signing in to sync its own folder: a desktop app signs in only for hosted features; [ADR-0821](0821-a-computer-remembers-what-it-synced-and-a-shell-limits-each-window-to-its-folder.md) at the stamp, `root.json`, the "Epicenter folder moved" branch, a shell command writing records, and a first-party desktop app reaching every folder: a folder's identity is its inode and birth time with one fallback, only Epicenter writes records, and a desktop app reaches no folder on the server; [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at each folder's `.epicenter/`: a folder holds no Epicenter state.
- **Relates:** [ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md) (one engine per computer syncs every app's folder, retired by 0750), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (any program can sync a folder), [ADR-0817](0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md) (an app inherits everything about folders).
- **Unbuilt:** all of it: records and hash caches named by identity at the Epicenter folder's root; the identity rules; temporary files beside their targets under reserved names; desktop apps without sync, with tokens holding only `ai`; an app finding its folder by identity, reading its record for marks, and opening any folder in the Epicenter folder; "Get Epicenter to sync" in apps; leaving Git working trees unsynced; removing the stamp, `.epicenter/` in folders, and the record command from the shells.

## Context

ADR-0821 kept each desktop app able to sync its own folder without Epicenter
installed, and that promise made every app carry sync, a sign-in that reaches
folders, a shell allowlist for sync routes, and a command to write records, and
let an app's page reach the records through that command. A folder also kept
Epicenter's state in its own `.epicenter/`: staged saves, recordings in
progress, a hash cache, and the stamp, which a copy carries along. In the
document architecture Epicenter follows, an app reads and writes documents and
the platform syncs them.

Three reviewers tested what removing that promise allows. Identity by the stamp
alone failed, because a copy carries the stamp and only the directory's inode
and birth time stay behind; identity by the inode alone leaks on file systems
that record no birth time, where a new folder can reuse a deleted one's inode;
and binding a folder by its name and identical files can attach a new private
folder to an idle shared one of the same name.

## Decision

**On a computer, Epicenter syncs and apps read and write files.** The Epicenter
app, the CLI, and `epicenter mcp` are the only programs that talk to the folder
server; a web app, which has no disk, syncs its own folder. A desktop app signs
in only for hosted features, its token holding only `ai`, and works fully on one
computer without Epicenter, offering Epicenter to sync across devices.

**A folder holds only its content.** A write stages its bytes in a hidden file
beside its target, named `.ep-<random>.save`, created with mode 0600, and
renamed over the target; a recording in progress is `.ep-<random>.recording`
beside its final path. No listing, watcher, or sync describes these names;
recovery removes stale saves anywhere in the folder and never a recording, which
its recorder recovers, nor any other hidden file. The Epicenter folder keeps
everything else:

```
~/Epicenter/
  .epicenter/
    synced/<folder-id>.json   { folder, name, inode, birthtime, commit, files }
    hashes/<identity>.json    a cache; losing it costs only speed
  Recipes/
    epicenter.json
    ...the person's files
```

Only Epicenter writes these. A desktop app keeps its own hash cache in its app
data, and reads the record matching its folder to show the marks.

**A folder is the directory its record names, proven in this order.** Across
the whole Epicenter folder:

1. A directory whose inode and birth time match a record is that folder, with
   its agreed state, wherever it has moved, when both sides have a real birth
   time.
2. For a record no directory matched, a directory with its recorded name and
   exactly its recorded files is that folder, when the server says the person
   is its only member.
3. Every other directory is unbound. A record proves at most one directory.

An unbound folder stays local until an app makes it or the person syncs it.
Then one question offers the folders the person holds that are not bound here,
matched by name or title and showing members; a shared folder that met rule 2's
files is offered selected. A folder held by the person alone that matches
exactly one joins without asking; one named as an app names its folder, with a
contract that fits the app, counts as made by that app. Every binding not proven
by rules 1 and 2 starts from first contact, which never deletes, and a sync that
would push many deletions stops and asks.

**Epicenter never syncs a Git working tree.** A folder whose real path is in a
Git working tree (`.git` at its root, or in a directory above the target of a
folder that is a link) is shown as kept by Git, and apps open it as any folder;
Epicenter does not sync it, so a branch switch never reaches another computer
as edits.

**An app finds its folder by its identity.** Its shell remembers its folder's
inode and birth time, and at start opens the directory in the Epicenter folder
that matches them before making one at its usual path, when both sides have a
real birth time. Any folder in the Epicenter folder can be an app's folder, so
Open with can open it.

## Consequences

- A desktop app has no sync, no folder access on the server, and no record to
  write; its page cannot reach a folder it does not show.
- Syncing across devices needs Epicenter installed, and runs while it does.
- A folder kept in Git syncs through Git, never through Epicenter.
- Copying, zipping, or handing on a folder carries nothing of Epicenter's.
- Restoring older contents into the same directory pushes their deletions, which
  the deletion guard and the folder's history recover.
- On a file system without birth times, a renamed folder is not followed and
  asks once.
- After a move to a new computer, a shared folder with unsynced edits is offered
  in the question rather than kept silently.
