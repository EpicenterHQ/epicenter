# 0865. The Epicenter Mac app runs `epicenter serve`, so the computer it is on is your server

- **Status:** Proposed
- **Date:** 2026-11-10
- **Relates:** [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one copy, clients that ask), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (`epicenter` runs Git's porcelain), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (LFS), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (the remote), [ADR-0878](0878-the-os-keeps-epicenter-serve-running-under-a-job-the-person-installs.md) (the job that keeps `serve` running).
- **Unbuilt:** all of it: the app in `apps/epicenter/` (only Tauri's generated `src-tauri/gen/` exists, untracked), its bundled `epicenter`, `git`, and `git-lfs`, the menu bar item, and registering ADR-0878's job.

## Context

ADR-0864 makes your server the computer that runs `epicenter serve` and holds
the one copy of each app; phones, browsers, and agents ask it. Getting a server
takes a terminal: Bun or the compiled `epicenter`, `git` (on macOS only after
the Xcode Command Line Tools), `git-lfs` (never on macOS by default), and a way
to keep `serve` running. On the author's Studio, `serve` runs in a shell that
stops when the shell does. ADR-0864 deleted "the Epicenter app for Mac and
iPhone", which was ADR-0863's app holding a copy of every app on every device.

A person with one Mac and no terminal, such as the author's brother starting
from the Vocab template, has no way to get a server at all.

## Decision

**The Epicenter Mac app is `epicenter serve` with a window.** It adds no
actions, storage, or sync of its own; anything it does, the `epicenter` command
does.

```txt
Epicenter.app/Contents/MacOS/
  Epicenter          the window and the menu bar item (Tauri)
  epicenter          `bun build --compile` of packages/cli, a sidecar (bundle.externalBin)
  git, git-lfs       the Git it runs
```

- The app starts no process of its own. `serve` runs under the LaunchAgent of
  ADR-0878, which the app registers for `~/Epicenter` through
  `SMAppService.agent`, the job `epicenter service install` writes. If that
  job is already registered, the app shows it.
- The window shows the launcher at `http://localhost:<port>/`, the page a phone
  sees at `/`.
- A menu bar item shows whether `serve` is running and restarts it; closing
  the window or quitting the app leaves it running.
- Its one setting is "Run Epicenter", which registers or unregisters the job.

**The app carries its own Git.** It puts its bundled `git` and `git-lfs` first
on the `PATH` of the `serve` it starts, and sets LFS's filter for that Git in
the environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`,
`GIT_CONFIG_VALUE_<n>`), never in the person's `~/.gitconfig`. `epicenter`
typed in a terminal uses the computer's own Git as before. Which files go
through LFS stays each folder's `.gitattributes`, and where their bytes go stays
its `origin` or `.lfsconfig` (ADR-0856).

**The computer the app is on is your server.** On a Mac that is the only
computer, the app is all of Epicenter: the apps, their actions and views, and
MCP for agents on that Mac. With "Run Epicenter" on and the Mac left on, it is
the server every device reaches (ADR-0864). A phone is always a client.

**It is a notarized download, not a Mac App Store app.** The store's sandbox
reaches only folders a person picks and confines every program the app starts;
`epicenter serve` reads all of `~/Epicenter` and runs each trusted
`epicenter.ts`.

## Consequences

- One install gives a person a server. The ladder in `docs/vision.md` is the
  same; the app installs rungs 2 to 4 at once.
- A phone reaches the app's Mac only while it is awake and reachable, over a
  tailnet until `serve` has sign-in (ADR-0864). A person whose phone must work
  while their only Mac sleeps needs a computer that stays on.
- The app ships Git and Git LFS, and their updates, with each release.
- The author's Studio can run the app or `epicenter service install`; either
  way one launchd job keeps `serve` running across restarts.
- A second Mac holding its own copy and pushing to your server is not part of
  this decision; until something needs it, a second Mac uses a browser.

## Considered alternatives

- **An Epicenter app holding a copy on every device (ADR-0863).** Git, a merge,
  and App Review on the phone, for offline use nobody asked for.
- **A native app per Epicenter app ("Vocab by Epicenter") with its own Git and
  sync.** Each app repeats sync, merge, and Git; a phone app must be a Git copy
  or ask a server anyway.
- **GitHub as the meeting point, so that apps work without a server.** Every
  surface becomes a Git client that merges, including the phone (ADR-0864).
- **The computer's own `git`.** macOS asks to install the Xcode Command Line
  Tools on first use, and has no `git-lfs`.
- **libgit2 in the app.** It does not run LFS's filter, and `epicenter` runs
  Git's porcelain (ADR-0850).
- **A LaunchAgent installed by `epicenter`.** Persistence the program sets up
  for itself; a login item is a setting the person turns on and sees in System
  Settings.
- **A hosted server for people without a computer that stays on.** Not this
  record's: such a person rents a home, which runs `epicenter serve` without
  the Mac app (ADR-0903).
