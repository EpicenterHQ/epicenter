# 0751. Every native app carries one sync core

<!-- doc-path-check: ignore-file (cites the waiting folder sync product (ADR-0840), kept at tag folder-sync-product) -->

- **Status:** Superseded
- **Date:** 2026-11-04
- **Superseded by:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md): a computer keeps a plain folder, every surface syncs with one TypeScript function, and no client links a Git library.
- **Supersedes:** [ADR-0748](0748-epicenter-ships-a-portable-git-inside-the-app.md) (Epicenter ships a portable Git inside the app): no Git program ships, so no license review of distributing GPLv2 Git is needed.
- **Amends:** [ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md) at "An app cannot sync without the Epicenter app installed", at apps calling the engine to sync, and at "The system `git` stays the network and history tool": every native app links the core and syncs its own folder, and no Git program runs; [ADR-0747](0747-git-runs-only-as-git-on-the-desktop.md) at "the `git` and `git-lfs` programs, run by `epicenter sync`": a round runs in the linked core over libgit2 and leaves a repository stock `git` reads; [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) at "Epicenter requires the system's `git`", at "Epicenter ships `git-lfs` inside the app", and at passing `-c merge.epicenter.driver` on each `git merge`: the core runs no Git program, merges notes in its own process, and moves Git LFS objects itself; [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md) at "An app calls that path": an app links the core, and `~/.epicenter/bin/epicenter` serves terminals, agents, and the native host; [ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md) at principle 6's "syncing goes through Epicenter's engine" and principle 7's "one engine": each native app syncs through its own copy of one sync core.
- **Relates:** [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) (when a program runs a round), [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) (where a folder is), [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md) (one merge rule), [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) (first contact), [ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md) (sync diffs state), [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (a phone app runs Git from a Rust library).
- **Amended by:** [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at the server keeping the TypeScript `settle`: it runs in the core and the page, and the server merges nothing.
- **Amended by:** [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) at `settle` moving into the core: it has one implementation, in TypeScript, which the core asks its host for.
- **Amended by:** [ADR-0794](0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md) at the plugin's moments and the working-tree recheck: the shell owns an app's moments while the core stays, a live page answers settle, and checkout writes only what did not move.
- **Unbuilt:** a working-tree recheck before merge; paths that differ only in case; `settle` in Rust; an iOS app build; `tauri-plugin-epicenter`; the CLI and the Epicenter app running rounds on the core.

## Context

Desktop sync runs in the `epicenter` CLI, a Bun program the Epicenter app
carries (75 MB compiled). The CLI starts the `git` and `git-lfs` programs
(`runGit` in `packages/folder/src/git/native-host.ts`) and has Git call
`epicenter merge-driver`, which runs `settle`
(`packages/definition/src/merge/settle.ts`), for each note.
[ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md)
keeps one such engine per machine, so an app cannot sync without the
Epicenter app installed.
[ADR-0748](0748-epicenter-ships-a-portable-git-inside-the-app.md) would ship
dugite-native's portable Git with Git LFS inside the app, 63 MB compressed
on macOS arm64, after a license review of distributing GPLv2 Git.

Both records refused a Git library. ADR-0713 refused a Rust engine because
`settle` also runs on the server and in the page. ADR-0748 refused libgit2
and gitoxide because they would not run Git LFS's filters or Epicenter's
merge driver the way stock `git` does. Neither runs on a phone:
[ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) builds
an installed phone app with Git from a Rust library, and the Bun engine does
not run on iOS. gitoxide cannot push and has no Git LFS (DeepWiki,
GitoxideLabs/gitoxide).

A spike on branch `claude/spike-sync-core` (commits `8dc6d63ed0` to
`ca35dbe098`) built one round over libgit2 (`git2`) in Rust: Git LFS clean,
smudge, and batch transfer done by the core, first contact
([ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md)), a
three-way merge that calls `settle` for notes, and push with retry. Bun
loaded it through Node-API (napi-rs) and supplied `settle` from
`@epicenter/definition`. Its 11 Rust and 6 Bun tests pass against
`git http-backend` and a Git LFS batch server behind a bearer token. After a
round, stock `git status` is clean and `git fsck` passes. `bun build
--compile` embeds the addon. The addon is 5.5 MiB with OpenSSL linked
statically and 2.5 MiB without.

Timings for a folder of 10,000 items, against today's CLI
<!-- doc-path-check: ignore-next-line -->
(`packages/sync-core/bench/compare.ts` on the spike branch):

| Round | Core | CLI |
| --- | --- | --- |
| first commit and push | 0.87 s | 6.36 s |
| unchanged | 0.08 s | 0.48 s |
| 10 edits | 0.17 s | 0.61 s |
| restore | 0.79 s | 1.41 s |
| merge | 0.28 s | 1.47 s |

## Decision

**Every native Epicenter program links one Rust sync core, `epicenter-core`,
and runs a whole round in its own process.** No `git` or `git-lfs` program
runs.

| Step of a round | What the core does |
| --- | --- |
| commit | stages the folder, running Git LFS clean itself for every file other than a note ([ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md)) |
| fetch | fetches `main` over HTTPS |
| first contact | puts the folder's files on top of the account's `main` in one commit ([ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md)) |
| merge | merges three ways against `refs/epicenter/last-seen`; `settle` for every item both sides changed, every other file kept whole with both versions |
| checkout | writes files, running Git LFS smudge itself |
| push | uploads Git LFS objects, then pushes, fetching and merging again when the remote moved |

**A bearer token travels on each request and is never stored.** The core
sends `Authorization: Bearer <token>` on every Git and Git LFS request to
the account's origin and writes nothing but `remote.origin` into Git
configuration ([ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md)).

**Each kind of program reaches the core one way.**

```txt
epicenter-core            the round, items, settle, roots, credentials (Rust, libgit2)
  Tauri desktop apps      linked through tauri-plugin-epicenter
  Tauri phone apps        linked through tauri-plugin-epicenter
  the CLI (Bun)           loaded through Node-API: epicenter sync, epicenter native-host
tauri-plugin-epicenter    the shell's commands and events, and the sync moments (ADR-0750);
                          replaces packages/tauri-plugin-epicenter-folder
```

App code calls no sync function. The plugin runs a round at the moments
[ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md)
names.

**TypeScript stays the language of contracts, scripts, and app UI.** Rust
holds only what must behave the same in every native program.

**`settle` moves into the core, and the server keeps the TypeScript
`settle`** until a single source for both is wanted. The TypeScript tests in
`packages/definition/src/merge` are the conformance suite the Rust port
passes.

**No Git program ships.** libgit2 is GPLv2 with a linking exception, which
permits linking it into a program under another license, so Epicenter
distributes no GPLv2 program and needs no review of shipping one. The
license review of dependencies still confirms this.

**The Epicenter app becomes the library.** It shows every folder, syncs
every consented folder at its moments, carries the CLI that agents and
terminals use, registers the browser extension's native host, and offers
Add, Move, and Restore. It runs rounds through the same core, not by starting the CLI.

## Consequences

- A standalone app syncs its folder with no other program installed, once
  it signs in as its site ([ADR-0731](0731-every-app-signs-in-as-its-site.md)).
  Each app shows sign-in and the first-contact consent screen itself.
- In the spike, a round over 10,000 items ran 1.8 to 7.3 times faster than
  the CLI's.
- Each app grows by the core: 5.5 MiB with OpenSSL linked statically, and
  2.5 MiB once the Rust transport removes OpenSSL. The Epicenter app does
  not grow by 63 MB of Git.
- No machine needs a system `git`, Apple's developer tools, or `git-lfs` on
  any `PATH`, including the one Chrome gives a native host.
- The Epicenter app's CLI spawning goes:
  `apps/epicenter/src-tauri/src/cli.rs` and
  `apps/epicenter/src-tauri/src/synced_folders.rs`.
- Two `settle` implementations exist, Rust in the core and TypeScript on the
  server, held together by one test suite until a single source is wanted.
- Epicenter now maintains Git behavior Git maintains for others: repacking,
  case-only paths, renames, and the transport. Each is in the `Unbuilt`
  line.
- A person's own `git` in a folder is still plain Git and still needs their
  own `git-lfs` ([ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md)).
- The core's output must stay readable by stock Git. A round that leaves
  `git status` dirty or fails `git fsck` is a bug in the core.
- A Git security fix in libgit2 needs a release of every app.

## Considered alternatives

- **A portable Git inside the Epicenter app (ADR-0748).** 63 MB in one app,
  a GPLv2 distribution review, apps still unable to sync alone, and nothing
  for phones.
- **The system `git` (ADR-0733).** An installer prompt on macOS, a Git
  version that varies by machine, and no phone.
- **One engine per machine (ADR-0713).** Every app depends on the Epicenter
  app for sync.
- **gitoxide.** It cannot push and has no Git LFS.
- **A core in TypeScript under Bun.** Bun does not run on iOS, and a Git
  engine in TypeScript is refused
  ([ADR-0747](0747-git-runs-only-as-git-on-the-desktop.md)); running Git
  programs from it brings back a Git to ship.
