# 0567. Epicenter ships for macOS only, for now

- **Status:** Superseded
- **Date:** 2026-10-16
- **Superseded by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md): the full desktop app platform; only a local built-app runner over chosen data repositories remains, without source installation, build approvals, or general native services.
- **Amends:** [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md) at "Epicenter bundles `git` only on Windows, as MinGit", its Windows installer consequence, and its MinGit checks: no release bundles `git`, and a Mac without the Command Line Tools installs them from the Folders window.
- **Relates:** ADR-0566 (deleted) (the command link, whose platform table and NSIS hook this decision removed while 0566 was still Proposed), [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (the `epicenter` CLI), [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) (its serving probe now runs on one platform).
- **Unbuilt:** a release workflow for the macOS app.

## Context

The desktop app builds one bundle, `"targets": ["app"]` in
`apps/epicenter/src-tauri/tauri.conf.json`, and no workflow under
`.github/workflows/` builds a desktop release. No person runs Epicenter on
Windows or Linux. The code still carried guesses at both:

- `packages/cli/src/install-command.ts`: a copy of the binary for a Linux
  AppImage, the installed `.exe` as Git's command on Windows, a refusal of
  `install-command` on Windows, and `~/.local/bin` as Linux's `PATH` link
  beside macOS's `/usr/local/bin`.
- `packages/cli/src/app-paths.ts`: `LOCALAPPDATA` and the XDG directories.
- `apps/epicenter/src-tauri/src/cli.rs`: `epicenter-cli.exe` and a
  `taskkill /T` stop for a window's children.
- `apps/epicenter/src-tauri/src/history.rs`: `install_git` opening the Git
  for Windows page, and a message for Linux.
- ADR-0559's plan to bundle MinGit on Windows, with its license review and a
  `!`-prefixed helper check under MinGit; ADR-0566's per-platform table of
  what Git's configuration names and its `NSIS_HOOK_PREUNINSTALL`.

None of it ran, so none of it was tested, and each branch was written
against an installer that does not exist.

## Decision

**Epicenter ships for macOS only.** Code that runs on the desktop, in the
`epicenter` CLI, or in Git's configuration is written for macOS and has no
Windows or Linux branch:

```txt
packages/cli/src/app-paths.ts        ~/Library/Application Support/so.epicenter, ~/Library/Caches/so.epicenter, ~/Epicenter
packages/cli/src/install-command.ts  one link, ~/.local/bin/epicenter -> the bundled binary
apps/epicenter/src-tauri/src/cli.rs  epicenter-cli beside the executable; a child's group stopped with SIGTERM, then SIGKILL
apps/epicenter/src-tauri/src/history.rs  install_git runs xcode-select --install
```

The CLI's tests still run on Linux CI: nothing in them depends on the host
being a Mac beyond the paths above, which are strings.

**No release bundles `git`.** The CLI runs the developer directory's `git`
(`locateGit`, ADR-0559), and `GitMissing` offers the Command Line Tools
installer.

**Reintroducing a platform is its own record, written with its first release
target.** That record names, for the platform:

- the bundle target in `tauri.conf.json` and the workflow that builds and
  signs it;
- the app's data, cache, and folder directories, in `DesktopPaths::resolve`
  (`apps/epicenter/src-tauri/src/app_data.rs`) and `resolveAppPaths` alike;
- what Git's configuration names in place of `~/.local/bin/epicenter`, and
  how it survives moving or updating the app (ADR-0566);
- how the shell stops a CLI child and every process it started;
- where `git` comes from, with its licenses if it is bundled;
- how an uninstall leaves Git's configuration;
- the checks the platform needs first: `Bun.secrets` from the signed binary,
  the serving probe of ADR-0561, and a clean-machine install.

## Consequences

- Each removed branch is rewritten against a real installer when its
  platform arrives, with tests that run there.
- `epicenter` cannot be installed on Windows or Linux from the app. The CLI
  still runs from source there for development, with macOS paths.
- The macOS release grows by nothing; the Windows installer's 40 MB of MinGit
  is not planned.

## Considered alternatives

- **Keep the branches, untested, for later.** They cost review on every
  change to the command link, the stop path, and the paths, and they were
  guesses at installers that do not exist.
- **Linux as well, since it shares Unix paths.** It needs its own data
  directories, a Secret Service for `Bun.secrets`, and an AppImage answer to
  the command link, none of which has a release to test against.
