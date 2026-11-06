# 0809. A repository is a space's app, and bytes nothing needs are collected or purged

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) at `.epicenter/synced.json` naming the repository: it names the space's id and the app; [ADR-0808](0808-a-files-version-is-its-git-blob-id-on-every-store.md) at `/<repository>/blobs/<sha256>`: a repository is addressed as `/spaces/<space-id>/apps/<app>`.
- **Relates:** [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) and [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) (a space owns one repository per app), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (an app's names derive from its site), [ADR-0776](0776-a-notes-name-is-its-file-name.md) (an item's name is its file name), [ADR-0805](0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md) (a folder is recognized by `epicenter.json`), [ADR-0788](0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md) (audio is the heaviest data).
- **Amended by:** [ADR-0810](0810-a-folder-needs-no-app-and-a-repository-is-a-spaces-named-folder.md) at `/spaces/<space-id>/apps/<app>` and `{ space, app }`: `/spaces/<space-id>/folders/<name>` and `{ space, name }`.
- **Amended by:** [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at a repository addressed by space: it is `/folders/<id>`.
- **Unbuilt:** all of it: sync, blob, and history routes at `/spaces/<space-id>/apps/<app>/…`; the manifest's `{ space, app }`; `<space name>/<app>` resolved to a space's id for clone URLs and screens; the upload ledger and its daily expiry; the storage view and Purge; a restored version showing that its audio was purged; deleting a repository's stored bytes with it.

## Context

Things inside a folder are identified by their paths: an item by its file
name, a folder by the `epicenter.json` it holds, whatever it is called. Things
the server stores and people share have ids: a space has an id and a name a
person can change. A repository had both an id and a name, `<space>/<app>`,
with routes addressing it by name and its stored bytes keyed by id, though it
is fully determined by its space and its app, and an app's name derives from
its site and never changes. Blobs never change once written, so removing one
is a question of when nothing needs it: an upload whose sync stopped before
its commit, or a recording deleted from the current files but kept by
history.

## Decision

**Inside a folder a path is identity; on the server an id is, and a name is a
label pointing to one.** A space is its id, with a name a person can change.
An app is its site.

**A repository is a space's app, with no identity of its own.** It is
addressed as `/spaces/<space-id>/apps/<app>`, `<app>` being the name derived
from the app's site, and the manifest stores `{ space, app }`. People see
`<space name>/<app>` on screens and in clone URLs, resolved to the space's id,
so renaming a space changes nothing a computer stored. A repository's key in
the server's tables is private.

**An upload is pending until a commit keeps it.** The server records each
upload as pending, a commit that references it keeps it, and one still pending
after a day is deleted, with no walk over history.

**A person purges what only history holds.** Each space has a storage view
listing its large blobs and marking those that are in no current file. Purge
deletes such a blob's bytes and rewrites no history: the commits still record
that the file existed, and restoring a version brings back its note with its
audio marked purged. Nothing a commit kept is deleted on its own.

**A repository's bytes go with it**, and are never shared between
repositories, so one space cannot learn whether a file exists in another.

## Consequences

- One rule for identity: paths in a folder, ids on the server, names as
  labels.
- A space can be renamed freely, and a repository needs no id of its own.
- Interrupted syncs leave nothing behind for long.
- People reclaim storage without rewriting history; a purged recording cannot
  be played from an old version.

## Considered alternatives

- **A repository id in every address:** a third kind of identity for something
  its space and app already determine.
- **Collecting by walking history for unreferenced blobs:** Git's way, costing
  more as history grows.
- **A retention window that purges history's recordings after a time:** storage
  stays bounded, and a person's old audio disappears without being asked.
- **Rewriting history to remove a recording:** truly gone, and every clone
  diverges from the server.
