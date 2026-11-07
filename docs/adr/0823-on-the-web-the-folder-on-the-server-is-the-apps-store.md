# 0823. On the web, the folder on the server is the app's store

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0807](0807-an-app-writes-only-to-a-local-store-and-only-sync-talks-to-a-server.md) at "An app writes only to a local store, and only sync talks to a server", "On the web the local store is memory, seeded from the repository", a web app syncing as a burst of saves ends, and "The server has no single-file routes": a web app's store is the folder on the server, and nothing syncs on the web.
- **Relates:** [ADR-0822](0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md) (only Epicenter syncs on a computer), [ADR-0808](0808-a-files-version-is-its-git-blob-id-on-every-store.md) (a write expects a version), [ADR-0786](0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md) (every web app is online).
- **Amended by:** [ADR-0830](0830-epicenter-sends-a-change-the-moment-it-happens-and-checks-for-others-every-thirty-seconds.md) at saves arriving together landing as one commit: a web app saves when typing pauses.
- **Unbuilt:** saves debounced into fewer commits; removing the memory store's seeding and the web's sync moments from code and docs.

## Context

ADR-0807 gave a web app a memory store seeded from the repository's snapshot
and synced it back after bursts of saves, so that every app wrote only to a
local store. Since ADR-0822 no app syncs on a computer, and the web build
already opens the folder on the server directly: `folderRepository` offers the
store's verbs, and its `put` is a commit that expects the version it read, so a
write that loses a race answers `Moved` and the folder's own write rereads and
merges, as it does on a disk. A web app is online by ADR-0786.

## Decision

**An app writes to its folder's store: on a computer the disk, on the web the
folder on the server.** Only Epicenter syncs, and only between the two. A web
app's write is a commit expecting the version it read; saves arriving within a
moment of each other may land as one commit. A web app watches the folder by
asking what changed since its commit.

## Consequences

- The web has no memory copy to seed, no sync moments, and no unsynced changes
  to guard when a page closes.
- Each save waits for the network, and the folder's history records saves as
  they land.
- A tab cannot edit while offline, as before.
