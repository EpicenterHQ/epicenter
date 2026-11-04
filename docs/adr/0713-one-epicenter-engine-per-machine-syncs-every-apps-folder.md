# 0713. One Epicenter engine per machine syncs every app's folder

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0642](0642-each-desktop-app-selects-its-cli-independently-of-the-terminal.md) at "a desktop app that needs the CLI runs its matched private bundled executable": an app calls the one engine the Epicenter app installs at `~/.epicenter/bin/epicenter`, and bundles none.
- **Amended by:** [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) at installing and updating `~/.epicenter/bin/epicenter`, `git-lfs` installed beside the engine, and the `git` check at setup: the engine is a link into the Epicenter app's bundled CLI, `git-lfs` stays inside the app on `PATH` only for Epicenter's runs, and a named setup step triggers the platform's Git installer; [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) at the Epicenter app owning `sync --watch` and at "Syncing needs Epicenter": any program with a credential runs a round when an app opens, after a save, on return to its window, and on Sync, and no app shows that message; [ADR-0751](0751-every-native-app-carries-one-sync-core.md) at "An app cannot sync without the Epicenter app installed", apps calling the engine to sync, and the system `git` as the network and history tool: every native app links one sync core and syncs its own folder, and no Git program runs.
- **Unbuilt:** other apps' calls to the engine; "Syncing needs Epicenter"; credential use for remotes other than Epicenter's.

## Context

Desktop sync runs in the `epicenter` CLI. `apps/epicenter/scripts/build-sidecar.ts`
compiles it with `bun build --compile` into
`apps/epicenter/src-tauri/binaries/epicenter-cli-aarch64-apple-darwin`, which
measures 75 MB on disk and about 33 MB gzipped. Most of that is the Bun runtime.

The CLI runs the system `git` and `git-lfs`: `runGit` in
`packages/folder/src/git/native-host.ts` finds `git`, and
`packages/cli/src/sync/setup.ts:254-262` runs `git lfs install --local`. A stock
Mac has neither: the first `git` call prompts to install Apple's developer
tools, and `git-lfs` is absent.

ADR-0642 has each desktop app run its own matched private copy of the CLI, so an
app could sync without the Epicenter app installed. Five apps carrying a copy is
375 MB, and each copy still fails on a Mac without `git-lfs`. Each copy also
writes shared state (the global `epicenter.folder` list, credentials) that every
other copy must read the same way.

## Decision

**A machine has one `epicenter` engine, installed and updated by the Epicenter app.**

```txt
Epicenter app        installs and updates   ~/.epicenter/bin/epicenter (compiled Bun CLI), ~/.epicenter/bin/git-lfs
                     checks at setup        git (explains Apple's developer-tools prompt)
                     owns                   consent screen, sync --watch, the root scan
Whispering, Capture, calls when present      epicenter sync <folder> --json, epicenter status --json
other apps           otherwise shows         "Syncing needs Epicenter" and a download link
```

- **Apps bundle no CLI.** An app calls `~/.epicenter/bin/epicenter`, the one
  place every program finds the engine ([ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md)). When it is present,
  "Sync now" and the sync status are calls to it, with or without an Epicenter
  window open. A terminal user adds `~/.epicenter/bin` to `PATH`;
  `install-command` and its `~/.local/bin/epicenter` symlink retire.
- **The first sync of a folder goes through Epicenter's consent screen.** The
  app opens `epicenter://init?path=…&contract=…` (`syncWithEpicenter` in
  `packages/folder/src/epicenter-sync.ts`). If no program handles the link, the
  app shows "Syncing needs Epicenter".
- **`git-lfs` ships with the Epicenter app** and installs beside the engine at
  `~/.epicenter/bin/git-lfs`; the engine uses that copy.
- **The system `git` stays the network and history tool.** Epicenter checks for
  it during setup instead of letting Apple's prompt appear in the middle of a
  sync.
- **The merge stays TypeScript.** `settle` (`packages/definition/src/merge/settle.ts`)
  is the engine's merge driver and also runs on the server for web writes
  (`packages/server/src/routes/files.ts:373`).

A folder on a host other than Epicenter (GitHub, a self-hosted Git server)
syncs through the same engine once its remote is set with `epicenter connect`
or `git remote`. The engine's credential handling sends Epicenter's token only
to Epicenter's remote; using a person's own credential helper for other hosts
is unbuilt.

## Consequences

- One 75 MB engine per machine instead of one per app. Apps lose that size.
- Every app on a machine runs the same engine version, so the root scan
  and the machine's sign-in (ADR-0720) have one reader and one
  writer implementation.
- An app cannot sync without the Epicenter app installed. Local saving needs
  no engine, so this costs only sync.
- The Epicenter app takes on installing and updating a binary plus `git-lfs`,
  and the `git` check.

## Considered alternatives

- **Each app bundles its own CLI (ADR-0642).** 75 MB per app, still needs
  `git-lfs`, and N copies must agree on shared state.
- **A Rust engine.** A few MB, small enough to bundle per app. `settle` also
  runs on the server and in the page (`findConflicts` in
  `apps/honeycrisp/src/lib/editor/conflicts.ts`), so Rust means compiling the
  merge to WASM or keeping two merges. ADR-0476 chose one Rust folder
  implementation before, and ADR-0531 superseded it.
- **The TypeScript engine in each app's page, with a Rust command running
  `git`.** No extra size per app, but sync lives only while the app runs, and
  the Git safety rules in `native-host.ts` would exist in Rust as well. ADR-0531
  and ADR-0559 moved Git out of the page to keep those rules in one runner.
- **Embedding Git as a library.** GitButler, a Rust Git client, runs the system
  `git` for clone, fetch, and push and bundles no `git-lfs`, per DeepWiki's
  index of its repository. Credentials and
  SSH are where an embedded Git diverges from the person's setup.
