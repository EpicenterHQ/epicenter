# 0695. One sync engine runs on every device, and a folder on disk is its watched projection

- **Status:** Accepted
- **Date:** 2026-10-29
- **Revisits:** [ADR-0692](0692-every-write-is-a-live-commit-on-its-parent-taken-through-the-repositorys-server.md) at "the live desktop folder is retired": the desktop keeps a live folder, written and watched by the same engine as the browser.
- **Relates:** [ADR-0620](0620-history-in-a-repository-only-grows.md), whose append-only history this relies on; [ADR-0693](0693-repositories-are-addressed-and-every-page-is-an-owner-a-repository-or-an-app-on-one.md).
- **Unbuilt:** the watcher, the desktop host of the engine, `epicenter sync` and `epicenter commit`, a Git store other than the memory and disk stores, receiving `git push` outside the spike.

## Context

Devices could sync two ways: the browser's replica, and a desktop folder kept
as a Git clone synced by live `git push`. That is two engines, the second
unbuilt and unmeasured for typing. Editors, agents and Obsidian need files on
disk; nothing needs those files to be the only copy.

## Decision

**One engine runs everywhere: the replica, with three front ends** (the
browser, the desktop app, and the CLI with no window). People's saves merge
live; an agent's work lands as one commit or not at all. Git is how history is
kept, and a door for anyone who prefers it.

**Typing is safe once it reaches the engine's database.** The page sends every
change as it happens and holds only what it shows; a keystroke in the instant
before a crash may be lost.

**On desktop, a repository is a folder its engine writes and watches.** A
remote change is merged and written to the file; a save in any editor is read,
compared by hash with what the engine last wrote, and sent as a write over
that text. A new file is a create, a missing one a delete, a rename both.
On startup the engine compares every file with what it last wrote, so edits
made while it was not running are sent. Folders sit under one movable root
(default `~/Epicenter`); folder names are local and free to rename, and each
carries its repository's id in `.epicenter/repository`, which nothing syncs.

**Two kinds of writing, one engine.** A person's save (in an app or in the
folder) merges into whatever is current. An unattended agent's batch
(`epicenter commit`, or `git push` to the server) is one commit, labelled with
the agent, and refused if `main` moved since it looked, so the agent redoes its
work against what is there.

**The server sits in front of a Git repository and is its only door.** It
orders writes, checks every note, and flushes to Git about once a minute.
History only grows: no client holds a credential that can rewrite or delete
`main`; undoing is a new commit. Which Git store holds the history is a port:
Epicenter's, a bare repository on disk for self-hosting, or a GitHub
repository whose `main` only the server may write, with pushes made there read
back through the same checks.

## Consequences

- One sync engine, reviewed and property-tested once; no Git on devices.
- The desktop keeps two copies in step, SQLite and the folder; the watcher's
  correctness needs its own property test (startup scan versus live events,
  editors that save by renaming, an editor holding a file a merge rewrites).
- A history rewrite (a committed secret) is an owner-only server operation
  every device must download again after; it is not offered until needed.
- Git remains the portable record: anyone can clone, diff and leave.

## Considered alternatives

- **The desktop folder as a Git clone synced by live push:** files as the only
  copy, at the cost of a second engine carrying live typing.
- **No folder on desktop:** editors and agents would lose ordinary files.
- **The page holding unsent typing until the engine answers:** typing lost on
  reload (found and fixed, then made unnecessary).
- **Agents writing the Git store directly:** bypasses the door's checks and
  ordering.
