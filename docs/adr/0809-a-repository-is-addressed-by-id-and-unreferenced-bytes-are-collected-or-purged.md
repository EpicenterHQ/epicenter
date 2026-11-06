# 0809. A repository is addressed by its id, and bytes nothing needs are collected or purged

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at `.epicenter/synced.json` naming the repository: it names the repository's id; [ADR-0808](0808-a-files-version-is-its-git-blob-id-on-every-store.md) at `/<repository>/blobs/<sha256>`: the repository in an address is its id.
- **Relates:** [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) and [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) (a space owns a repository per app), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (owners rename a space, never a repository), [ADR-0788](0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md) (audio is the heaviest data, and the hosted plan limits it).
- **Unbuilt:** all of it: sync, blob, and history routes at `/repos/<id>/…`; `<space>/<app>` resolved to an id for clone URLs and screens; collecting blobs no commit references once older than a day; the storage view and Purge; a restored version showing that its audio was purged; deleting a repository's stored bytes with it.

## Context

A repository has a stable id (`packages/server/src/db/schema/repository.ts`)
and a name, `<space>/<app>`. Routes address it by name, while its Git LFS
objects are stored under its id (`lfs/<repository id>/<sha256>`). A space can
be renamed, which would change every name a computer had stored. Blobs never
change once written, so the only question about removing one is when nothing
needs it: an upload whose sync stopped before its commit, or a recording
deleted from the current files but kept by history, which costs storage while
restoring an old version still needs it.

## Decision

**Programs address a repository by its id; people by its name.** The
manifest stores the id, and sync, blob, and history routes are
`/repos/<id>/…`. `<space>/<app>` names a repository on screens and in clone
URLs, and resolves to its id; renaming a space changes nothing a computer
stored.

**A blob no commit references is collected after a day.** An upload whose
sync never committed, or lost a race, is deleted once it is older than the
grace, so a sync still in flight never loses its upload; Git's own garbage
collection keeps the same expiry.

**A person purges what only history holds.** Each space has a storage view
listing its large blobs and marking those that are in no current file. Purge
deletes such a blob's bytes and rewrites no history: the commits still record
that the file existed, and restoring a version brings back its note with its
audio marked purged.

**A repository's bytes go with it.** Deleting a repository deletes everything
stored under its id, and bytes are never shared between repositories, so one
space cannot learn whether a file exists in another.

## Consequences

- A space can be renamed freely.
- Interrupted syncs leave nothing behind for long.
- People reclaim storage without rewriting history, and every clone of a
  repository keeps agreeing with the server.
- A purged recording cannot be played from an old version.

## Considered alternatives

- **Rewriting history to remove a recording:** truly gone, and every clone
  diverges from the server.
- **Keeping every committed blob forever:** simplest, and storage grows with
  every recording ever deleted.
- **Addressing repositories by name:** readable, and broken by renaming a
  space.
