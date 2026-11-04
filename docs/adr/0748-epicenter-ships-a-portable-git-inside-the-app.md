# 0748. Epicenter ships a portable Git inside the app

- **Status:** Superseded
- **Date:** 2026-11-04
- **Superseded by:** [ADR-0751](0751-every-native-app-carries-one-sync-core.md): every native app links one sync core over libgit2, so no Git program ships and no license review of distributing GPLv2 Git is needed.
- **Amends:** [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) at "Epicenter requires the system's `git`" and its setup step that triggers the platform's installer: Epicenter ships a portable Git with Git LFS inside the app, uses it for its own runs, and shows no installer prompt; and at "Epicenter ships `git-lfs` inside the app": that `git-lfs` is the one in the bundle.
- **Relates:** [ADR-0747](0747-git-runs-only-as-git-on-the-desktop.md) (Git runs only as Git), [ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md) (one engine per machine), [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (a desktop clone needs `git` and `git-lfs`).
- **Unbuilt:** all of it: the bundle inside the app for each platform; `locateGit` returning it; removing the search for a system `git` and `GitMissingError`'s installer messages. It ships only after a license review of distributing GPLv2 Git as a separate program: the license text in the app, and the source of the exact build made available.

## Context

[ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md)
requires the system's `git` and places one setup step that triggers the
platform's installer, `xcode-select --install` on macOS. It refused bundling
Git: "A relocatable build and a review of bundling GPLv2 Git with the app,
to avoid one prompt that the setup step already places."

`locateGit` in `packages/folder/src/git/native-host.ts` finds a `git` today:
`EPICENTER_GIT` when set, then on macOS `/opt/homebrew/bin/git`,
`/usr/local/bin/git`, and the rest of `PATH`, and `/usr/bin/git` last, only
when `xcode-select -p` names an installed developer directory. Without one,
`/usr/bin/git` is a shim that exits 1 and shows the Command Line Tools
dialog. When none runs, `GitMissingError` tells the person to run
`xcode-select --install`. Each machine syncs with whatever Git version it
has.

The relocatable build exists. dugite-native (`desktop/dugite-native`), which
GitHub Desktop ships through `dugite`, publishes Git with Git LFS that runs
from any directory. Its release `v2.56.0-2` (2026-10-26) carries Git 2.56.0
and Git LFS 3.8.1, built for macOS arm64 and x64, Windows x64, x86 and arm64,
and Linux x64, x86, arm64 and arm. Its macOS arm64 archive is 63 MB
compressed.

## Decision

**Epicenter ships a portable Git with Git LFS inside the app** and uses it
for every Git command it runs. Each Epicenter release pins one dugite-native
release.

**The system's Git is not required, and no installer prompt is shown.**
`locateGit` returns the bundled Git. The search of Homebrew, `PATH`, and the
developer directory goes, and so do `GitMissingError`'s installer messages.
`EPICENTER_GIT` still names a Git outright, for a CLI run from source.

**A person's own `git` stays theirs.** The bundled Git is on the `PATH` of
Epicenter's own runs only, and
[ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md)'s plain
Git rule stands.

**The bundle ships only after a license review** of distributing GPLv2 Git
as a separate program: the license text in the app, and the source of the
exact build made available.

## Consequences

- A first sync needs no setup step and no prompt, on every platform.
- Every machine syncs with the same Git version, the one Epicenter's tests
  ran against.
- The app download grows by the bundle, about 63 MB compressed on macOS
  arm64.
- Epicenter ships Git's security fixes: a Git release that fixes a
  vulnerability needs an Epicenter release.
- A machine can hold two Gits, the person's and Epicenter's. A person's own
  `git` in a folder still needs their own `git-lfs` (ADR-0733).
- Until the license review passes, ADR-0733's system Git and setup step are
  what ships.

## Considered alternatives

- **The system's Git with an installer prompt (ADR-0733).** One prompt at
  setup, a dialog on macOS when it is skipped, and a Git version that varies
  by machine.
- **Build a relocatable Git ourselves.** The work dugite-native already does
  and GitHub Desktop already depends on.
- **A Git library such as libgit2 or gitoxide.** It would not run Git LFS's
  filters or Epicenter's merge driver the way stock `git` does, which is the
  Git people and agents run ([ADR-0747](0747-git-runs-only-as-git-on-the-desktop.md)).
