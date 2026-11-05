# 0804. A computer keeps a plain folder, and every surface syncs with one TypeScript function

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Supersedes:** [ADR-0751](0751-every-native-app-carries-one-sync-core.md) (every native app carries one sync core): no client links a Git library, and the core is retired.
- **Amends:** [ADR-0772](0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md) at `.git/` naming a folder's repository and its space: `.epicenter/synced.json` names the repository and the commit last agreed, and a folder holds no `.git/` or `.gitattributes`; [ADR-0788](0788-everything-in-a-folder-syncs-and-a-recordings-audio-is-kept-in-one-of-three-places.md) at "Everything in a folder syncs": every visible file syncs, and a hidden path does not; [ADR-0794](0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md) at a round's checkout, moments in the shell, and the open decision: there is no checkout or round, moments live in the sync package, and the decision is made; [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) and [ADR-0801](0801-records-from-0763-to-0800-agree-on-the-merge-rust-patching-marks-and-agents.md) at the key merge's Rust twin: there is one implementation, in TypeScript; [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) at Rust holding "a round's Git work": Rust holds no Git; [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) at a folder being plain Git: a folder is plain files, and its history is cloned from the server; [ADR-0785](0785-a-desktop-app-signs-in-to-sync-its-own-folder.md) and [ADR-0791](0791-a-folders-first-sync-places-it-in-its-teams-folder.md) at the core running an app's sync: the sync package runs it in the page.
- **Relates:** [ADR-0802](0802-people-share-spaces-an-app-works-in-one-at-a-time-and-a-folder-carries-its-contract.md) (the lean), [ADR-0803](0803-clients-sync-only-with-epicenter-servers-and-sync-is-a-function-of-two-stores.md) (Epicenter servers only; sync is a function of two stores), [ADR-0778](0778-a-page-connects-once-and-then-reads-synchronously.md) (the open folder), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (sync at a person's moments).
- **Amended by:** [ADR-0805](0805-a-folder-is-recognized-by-epicenter-json-which-is-its-contract.md) at `.epicenter/sync.lock`: no lock; the manifest is written over the version the sync read.
- **Unbuilt:** the open folder listing every visible file; `.epicenter/sync.lock` around a sync; the server refusing a path that differs only in case from one it holds; moments in the sync package and each app syncing through it; the CLI's `epicenter sync`, `log`, `diff`, `restore`, and `clone` over the server; streaming a large attachment; retiring `packages/epicenter-core`, its Node-API addon, the merge driver, the CLI's Git sync, and the shell's sync enrollment.

## Context

ADR-0802 leaned toward a plain folder and ADR-0803 framed sync as
`sync(local, remote, manifest)`. A prototype built it in TypeScript over the
store contract (`@epicenter/folder/sync`, about 560 lines, with
`@epicenter/definition/front-matter`), with no Git on the client. Its thirteen
scenarios pass over memory and over a directory with the Postgres-backed
server: first contact, an unchanged sync that reads and writes nothing,
different fields and the same field changed on two sides, bodies changed
apart and at one spot, delete and edit against delete, an attachment replaced
on both sides, the server moving mid-sync, an agent writing a file mid-sync,
and a sync stopped before its server write or its manifest save. Its body
merge is a port of Git's own, matching `git merge-file` on 8,500 generated
merges.

At 10,000 items, with the app's open folder as sync's local side:

| Sync | Rust core (ADR-0751) | TypeScript, open folder |
| --- | --- | --- |
| unchanged | 0.08 s | 0.02 s |
| 10 edits | 0.17 s | 0.11 s |
| merge | 0.28 s | 0.14 s |
| first | 0.87 s | 1.2 s |
| restore | 0.79 s | 4.3 s |

The manifest needed one addition the design missed: the commit and version
each file last agreed at, since a sync's local and server writes land
separately and no single commit holds the agreed state.

## Decision

**A computer keeps a folder's files and its manifest, and no Git.**
`.epicenter/synced.json` names the repository, the commit last agreed, and
each file's version and the commit it last agreed at. History is the
server's Git, reached with `epicenter log`, `diff`, `restore`, and `clone`, or
cloned and pushed to with Git.

**Every surface syncs with `sync(local, remote, manifest)`, in TypeScript.**
In an app, the local side is the open folder: it read every file when it
connected and its watch keeps that current, so a sync lists nothing on disk.
The open folder lists every visible file, holding a contract's items as text
and any other file by its version alone, so `AGENTS.md`, `contract.json`, and
a person's own files sync too. A hidden path does not sync. The CLI, which has
no open folder, lists the directory. The moments (an app opening, a few
seconds after a save, the window returning, Sync pressed) live in the sync
package, beside the function.

**One sync of a folder runs at a time.** It holds `.epicenter/sync.lock`; a
second waits its turn.

**The server refuses a path that differs only in case from one it holds,** so
a case-insensitive disk never receives two paths it cannot keep apart. A
rename is a delete and a create.

**The Rust sync core retires.** No app links libgit2; the core, its Node-API
addon, the merge driver, and the CLI's Git sync go. Rust keeps the shell:
named roots, files and their watch, credentials, audio, and models.

## Consequences

- Desktop, web, phone, the CLI, and the library sync with one function, held
  by the store contract's conformance suite.
- No recording is stored twice on a computer, as Git LFS's object store
  stored it.
- A phone app syncs with its webview and a file store, with no cross-built Git.
- A folder cannot sync with GitHub or GitLab, and history on a computer is a
  command away, not a `.git/` directory.
- Restoring an empty folder is slower than the core's, by writing files one at
  a time; it is rare, and parallel writes are its fix.
- A file the watch did not report syncs at the app's next opening.
