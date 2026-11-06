# 0807. An app writes only to a local store, and only sync talks to a server

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) at `home` on the web being "the account's team's repository": it is a memory store seeded from the repository; [ADR-0786](0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md) at a web app living in the team's repository: it lives in memory, synced with it; [ADR-0798](0798-a-store-patches-fields-and-writes-text-and-a-change-is-data.md) at "The server patches field lines": the server has no `patch`, and `patch` is a local store's verb; [ADR-0800](0800-a-stores-wire-speaks-http-conditional-requests-and-apps-connect-agents-to-the-cli.md) at the server's single-file routes as HTTP conditional requests: the server has no single-file routes, and a local program's served store keeps that shape; [ADR-0806](0806-an-open-app-checks-for-changes-and-a-sync-never-silently-loses-an-edit.md) at the moments on the web: a web app syncs as soon as a burst of saves ends and when its page is hidden; [ADR-0788](0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md) at the marks: a file the server refused shows ✗ with the reason.
- **Relates:** [ADR-0803](0803-clients-sync-only-with-epicenter-servers-and-sync-is-a-function-of-two-stores.md) and [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) (one sync function), [ADR-0778](0778-a-page-connects-once-and-then-reads-synchronously.md) (the replica holds an attachment by version), [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) (a write never fails).
- **Amended by:** [ADR-0808](0808-a-files-version-is-its-git-blob-id-on-every-store.md) at attachments read through the repository: bytes at a stable, cacheable address.
- **Unbuilt:** all of it: the web's memory store seeded from a snapshot, holding attachments by reference; `sync` copying a remote attachment into such a store as a reference and uploading only bytes written locally; the web's moments; the leave guard reading unsynced changes; `<WhenOpen>` waiting for the seed; the ✗ mark; removing `home`'s web branch, the repository's store verbs, the server's single-file routes, and its `patch` route.

## Context

A desktop app writes to its folder on disk, and only sync reaches the server.
A web app opened the team's repository as its folder's store, so an ordinary
save went to the server, and a refusal there (a path differing only in case
from one the repository holds) had no outcome in the folder's write queue
but "unavailable, retry", and was retried forever. The web's write queue
carried the server's answers (412, refusals, the network) that the desktop's
never sees. An adversarial review of three reviewers, each reading the code,
agreed on the form below; each found that a web memory store holding every
file's bytes would download every recording on every page load, since a
reload starts empty.

## Decision

**An app writes only to a local store, and only sync talks to a server.** A
**store** is a place a program holds (memory, a directory, the desktop shell's
folder, a local program's served store), with the store contract's verbs. A
**repository** is the history sync exchanges with (`changes`, `snapshot`,
`readAt`, `writeAll`), and no app opens one as a folder.

**On the web the local store is memory, seeded from the repository.** Opening
takes the repository's snapshot as both the memory's contents and the
manifest, with nothing to merge. Memory holds an attachment by reference, its
version and size, and reads its bytes from the repository when they are
asked for. Sync copies a remote attachment into it as a reference, and
uploads bytes only for an attachment written locally. `<WhenOpen>` waits for
the seed.

**A web app syncs as soon as a burst of saves ends, and when its page is
hidden**; stopping a take starts one. Its leave guard holds the page while
memory holds changes the manifest does not, not only while a write is out.

**A file the server refuses shows ✗ with the reason**, on every surface,
reported by sync; the rest syncs.

**The server has no single-file routes and no `patch`.** Field changes land in
a local store and merge by key in sync; scripts reach a repository through
the CLI.

## Consequences

- Web and desktop differ only in the local store under the folder.
- The folder's write queue never sees a server's answer.
- A web page's first paint costs what it did: a listing and the notes, never a
  recording's bytes.
- A web change reaches the server a moment after the burst of saves that made
  it, and a reload or a crash before that loses it, as an unlanded write is
  lost today.
- Two tabs are two devices, each seeded from a snapshot.

## Considered alternatives

- **The folder's write queue learning a `refused` outcome:** fixes the loop and
  keeps a second write path with the server's semantics in every web app.
- **Browser storage for the web's local store:** survives a reload, and brings
  back the storage ADR-0786 removed.
- **A memory store holding every file's bytes:** every page load downloads
  every recording.
