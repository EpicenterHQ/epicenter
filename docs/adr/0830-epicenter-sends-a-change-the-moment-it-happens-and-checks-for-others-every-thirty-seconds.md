# 0830. Epicenter sends a change the moment it happens, and checks for others' every thirty seconds

- **Status:** Superseded
- **Date:** 2026-11-07
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0806](0806-an-open-app-checks-for-changes-and-a-sync-never-silently-loses-an-edit.md) at an open app checking the server every few seconds: it checks every thirty seconds; [ADR-0819](0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md) at syncing at moments and a few seconds after a change: Epicenter syncs a folder as soon as it changes on this computer, and checks the server every thirty seconds; [ADR-0823](0823-on-the-web-the-folder-on-the-server-is-the-apps-store.md) at saves arriving together landing as one commit: a web app saves when typing pauses.
- **Relates:** [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) (a line is the unit of merge), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (no second store).
- **Unbuilt:** all of it: a sync started by a change on disk; one check of every folder's head every thirty seconds; web saves when typing pauses; who edited a note, read from the log.

## Context

Sync ran on clocks: an open app asked the server every three seconds, a change
waited a few seconds before it synced, and web saves were batched by timing
windows. Nearly every request answered "nothing moved". Reviewers proposed a
notifier per person that would tell devices within a second, and a live
session per folder that would relay keystrokes, but only to programs holding a
socket to the server, so a desktop app would see edits later than a browser.
Both add objects, sockets, and their own protocols for freshness under a
second, which matters mainly when two people edit one note within the same
half minute.

## Decision

**Epicenter sends a change the moment it happens**: a change on disk starts a
sync of that folder, and changes that arrive together sync together. A web app
saves when typing pauses.

**Epicenter checks for others' changes every thirty seconds**, with one request
that answers every folder's head, and a web app checks its folder as often. An
edit made elsewhere reaches every surface within half a minute.

**A line stays the unit of merge.** Two people who change one paragraph within
the same half minute, or while apart, see both versions marked in the note.

**Who edited a note, and when, comes from the log.**

**There is no live session and no notifier.** A notifier that tells devices a
folder changed, as Dropbox's long poll does, can be added later without
changing anything else, since every device already asks what changed since its
cursor. An app that needs keystroke co-editing reopens ADR-0771.

## Consequences

- Desktop, web, agents, and Git edit a shared note the same way, with no server
  objects or sockets for freshness.
- Another person's edit can take up to thirty seconds to arrive.
- An idle device makes about one cheap request every thirty seconds.
