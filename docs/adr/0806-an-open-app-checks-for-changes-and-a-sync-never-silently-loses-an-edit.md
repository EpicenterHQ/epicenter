# 0806. An open app checks for changes, and a sync never silently loses an edit

- **Status:** Superseded
- **Date:** 2026-11-06
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) at "No program runs a file watcher, an interval timer, or a background service to sync" and "An idle app in the background does not show another device's change until the person returns to its window": an open app checks the server every few seconds; nothing runs once it closes.
- **Relates:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) (one sync function, moments in its package), [ADR-0786](0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md) (the web already checks every few seconds), [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) (an edit beats a delete).
- **Amended by:** [ADR-0807](0807-an-app-writes-only-to-a-local-store-and-only-sync-talks-to-a-server.md) at the moments on the web: sync as a burst of saves ends and when the page is hidden.
- **Amended by:** [ADR-0819](0819-every-program-keeps-the-folders-it-has-open-in-sync-and-the-epicenter-app-has-them-all-open.md) at "nothing runs once it closes": a folder keeps syncing while any program has it open, and the Epicenter app has every folder open.
- **Amended by:** [ADR-0829](0829-a-restore-never-deletes-on-a-device-and-historys-chain-covers-what-changed-not-who.md) at a hidden window pausing, which was never built.
- **Amended by:** [ADR-0830](0830-epicenter-sends-a-change-the-moment-it-happens-and-checks-for-others-every-thirty-seconds.md) at checking the server every few seconds: it checks every thirty seconds.
- **Unbuilt:** the periodic check in the sync package and in every open app.

## Context

A sync compares, for each file, what this computer and the server last agreed,
what is on disk, and what is on the server, and applies one table: nothing,
upload, download, or merge and upload. ADR-0750 ran it only at moments a person
causes, so a desktop app open but idle did not show a partner's edit until the
person returned to its window, while the web build of the same app asked the
server for changes every few seconds. Asking what changed since a commit is one
small request.

A rename is a delete and a create, and an edit beats a delete, so a rename on
one device and an edit of the old name on another leave both items, and a
deleted item edited elsewhere comes back.

## Decision

**An open app checks the server for changes every few seconds**, as the web
does, and syncs when there are any or when the folder holds unsynced changes.
It pauses while its window is hidden, and nothing runs once it closes. The
moments of ADR-0750 stay: opening, a few seconds after a save, returning to the
window, and Sync.

**A sync never silently loses an edit.** A rename beside an edit leaves both
items, and a deleted item edited elsewhere returns; both are visible and fixed
by hand. No rename is tracked and no deletion is remembered beyond the
manifest.

## Consequences

- A partner's edit appears in an open app within seconds, on the desktop and
  the web alike.
- An open app makes one small request every few seconds while visible.
- People occasionally see a duplicate after a rename, or an item they deleted
  come back, and never lose a change without seeing it.
