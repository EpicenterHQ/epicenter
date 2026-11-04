# 0733. Your own git in an Epicenter folder is plain Git

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) at "`epicenter auth login` writes Git's helper as two global entries": no Epicenter command writes a credential helper; [ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md) at "installs and updates `~/.epicenter/bin/epicenter`", "`git-lfs` ships with the Epicenter app and installs beside the engine", and the `git` check at setup: the engine is a link into the app, `git-lfs` stays inside the app, and setup triggers the platform's Git installer; [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md) at `bin/git-lfs` and `bin/epicenter` as an installed copy: `~/.epicenter/bin` holds one link.
- **Relates:** [ADR-0728](0728-a-build-states-its-environment.md) (a build states its environment), [ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md) (macOS only for now), [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md) (one merge rule).
- **Unbuilt:** `git-lfs` inside the app on `PATH` for Epicenter's runs; documenting the lines a terminal user adds for Epicenter's merge and helper.
- **Amended by:** [ADR-0748](0748-epicenter-ships-a-portable-git-inside-the-app.md) at "Epicenter requires the system's `git`" and the installer step: Epicenter ships a portable Git with Git LFS inside the app for its own runs, the system's Git is not required, and no installer prompt is shown, once a license review of distributing GPLv2 Git passes.

## Context

Epicenter writes three kinds of path into Git configuration today.

```txt
~/.gitconfig                 credential.<git audience>.helper = !'<engine path>' auth git-credential
                             (configureGitHelper in packages/cli/src/auth.ts, run by epicenter auth login)
<folder>/.git/config         merge.epicenter.driver = '<engine path>' merge-driver %O %A %B %P
                             (driverCommand in packages/cli/src/sync/setup.ts, written by init)
<folder>/.git/hooks/         pre-push, post-checkout, post-commit, post-merge from git lfs install --local
```

The engine path is `~/.epicenter/bin/epicenter`, a copy the Epicenter app
makes at every launch (`install_engine` in
`apps/epicenter/src-tauri/src/cli.rs`): it stages the bundled CLI beside the
destination, compares bytes, and renames it into place, with a separate
`MoveFileExW` path on Windows.

Each path costs something. The global helper lands in `~/.gitconfig`, which
many people keep in a dotfiles repository and copy to machines where the path
is wrong or Epicenter is absent. The driver path makes `round` in
`packages/cli/src/sync/sync.ts` refuse a clone whose driver names anything
else, so a folder copied from another machine stops syncing until `init`
runs again. The LFS hooks call `git lfs`, so a person's own push fails on a
machine whose `PATH` has no `git-lfs`.

Epicenter's own runs do not need any of it. `runGit` in
`packages/folder/src/git/native-host.ts` passes every `git` it starts its
safety settings with `-c` and hands it the token as a header
(`credentialEnvironment`). Hooks never run under it, so sync already pushes
LFS objects itself with `git lfs push origin HEAD` before it pushes
(`packages/cli/src/sync/sync.ts`).

## Decision

**Epicenter writes no path into any Git configuration.** A person's own
`git` in an Epicenter folder runs plain Git.

| Removed | Where it was written | What Epicenter does instead |
| --- | --- | --- |
| `credential.<git audience>.helper` | the person's global configuration, by `epicenter auth login` | gives each `git` it starts the token as a header, as today |
| `merge.epicenter.driver` and `merge.epicenter.name` | the folder's `.git/config`, by `init` | passes `-c merge.epicenter.driver=…` on each `git merge` it runs |
| the LFS hooks | the folder's `.git/hooks/`, by `git lfs install --local` | runs `git lfs push` itself, as today |

**The LFS filter settings stay.** `filter.lfs.clean`, `filter.lfs.smudge`,
`filter.lfs.process`, and `filter.lfs.required` name the command `git-lfs`
and hold no path. `.gitattributes` keeps `REPOSITORY_ATTRIBUTES`.

**Plain Git behaves as Git does.** A plain `git pull` merges a note with
Git's line merge, because `merge=epicenter` names a driver the configuration
does not define and Git falls back to its built-in merge. A plain push of a
file outside LFS that the contract stores in LFS is refused by the server
(`storedWithLfs` in `packages/server/src/routes/receive.ts`). A terminal user
who wants Epicenter's merge or helper in their own `git` adds the
documented lines themselves.

**`~/.epicenter/bin/epicenter` is a link into the Epicenter app's bundled
CLI.** Epicenter points it at the CLI beside its own executable at launch.
The copy, its byte comparison, and the Windows replacement path are deleted.
The CLI build states its environment
([ADR-0728](0728-a-build-states-its-environment.md)), so a link from
`~/.epicenter-dev/bin` and one from `~/.epicenter/bin` each run as the build
they point to, whatever the link's location.

**Epicenter requires the system's `git`.** A named setup step before the
first sync triggers the platform's installer: on macOS,
`xcode-select --install`. Sync never meets the prompt in the middle of a
round.

**Epicenter ships `git-lfs` inside the app** and puts its directory on `PATH`
only for the `git` it runs. Nothing is installed into `~/.epicenter/bin` but
the link.

## Consequences

- `~/.gitconfig` carries nothing from Epicenter, so a dotfiles repository is
  unaffected by signing in.
- A folder copied or restored from another machine syncs without `init`
  rewriting its configuration.
- A person's own `git pull` can stop with conflict markers in a note's front
  matter, which Epicenter's merge never writes. The person resolves them as
  in any Git repository; Epicenter's sync stops while that merge is in
  progress.
- A person's own `git` in a folder needs their own `git-lfs`: with
  `filter.lfs.required` set and no `git-lfs` on their `PATH`, checking out an
  LFS file fails.
- Moving or deleting the Epicenter app leaves the link dangling until the app
  next launches; the engine runs only while the app is installed.
- On Windows a symbolic link needs Developer Mode or administrator rights.
  Epicenter ships for macOS only
  ([ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md)); a Windows
  build decides its link form when it exists.

## Considered alternatives

- **Keep the global helper with an absolute path (ADR-0565).** Every path
  written into `~/.gitconfig` travels with dotfiles and goes stale when the
  app moves.
- **Write the driver per repository with a relative command.** Git runs a
  driver through the shell from the repository's top, so a relative command
  depends on `PATH` or on the folder's location.
- **Bundle `git` itself.** A relocatable build and a review of bundling
  GPLv2 Git with the app, to avoid one prompt that the setup step already
  places.
- **Install `git-lfs` into `~/.epicenter/bin`.** A second copied binary to
  update, for a tool only Epicenter's own runs need.
