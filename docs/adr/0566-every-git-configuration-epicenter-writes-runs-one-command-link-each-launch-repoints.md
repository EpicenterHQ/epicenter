# 0566. Every Git configuration Epicenter writes runs one command link, which each launch repoints

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at `install-command`, which points the one command link `~/.local/bin/epicenter` at the running binary, never with `sudo`.
- **Relates:** [ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md) (macOS only), [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md) (all desktop Git runs in the CLI), [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) (the global credential helper), [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) (deletes the plain-Git merge driver).
- **Unbuilt:** Settings showing that a launch under App Translocation, or a regular file at `~/.local/bin/epicenter`, left the link alone, which today only the log records; Settings telling a person whose `PATH` lacks `~/.local/bin` to add it.

## Context

Git configuration that names a program outlives the process that wrote it.
The global credential helper (ADR-0565) is run by any Git client a person
starts, including one started from the Finder, which gets launchd's `PATH`
(ADR-0559). A path to the bundle breaks when the app moves, and under macOS's
App Translocation it names a directory that disappears when the app quits.

## Decision

**Every Git configuration Epicenter writes runs one command link,
`~/.local/bin/epicenter`, which each launch points at the running binary.**
The link is `resolveAppPaths().commandLink`
(`packages/cli/src/app-paths.ts`), one per person whichever build runs:

```txt
~/.local/bin/epicenter -> /Applications/Epicenter.app/Contents/MacOS/epicenter-cli
```

The configured path is absolute because a Git client started from the Finder
gets launchd's `PATH`, and single-quoted for `sh`. A terminal reaches the
same link on `PATH` once a person adds `~/.local/bin` to it, one line in
their shell profile.

- `epicenter install-command` points the link at the running binary's real
  path, as a link staged beside it and renamed over it. It never needs
  `sudo`. A regular file at the link's path is someone else's and is refused.
- A release build runs `epicenter install-command --json` at every launch
  (`spawn_command_link_refresh` in `apps/epicenter/src-tauri/src/cli.rs`). A
  development build runs the CLI from source and leaves the link to the
  release build.
- Every command that writes Git configuration names the link and makes
  nothing (`AppPaths.commandLink`), whether it runs from the bundle, the
  link, or source, so a development run never writes a checkout into the
  global configuration.
- A binary under App Translocation
  (`/private/var/folders/.../AppTranslocation/`) leaves the link as it is.
  The command says so, and the launch call exits 1 and is logged.
- A `git` the CLI itself spawns may name the running binary's own path,
  which exists as long as the process does.

## Consequences

- Moving the app breaks the credential helper only until its next launch,
  which points the command link at it again; no global configuration is
  rewritten.
- After Epicenter is uninstalled, the link points at nothing. The credential
  helper fails with `sh`'s "No such file or directory", and Git asks for a
  username, or fails with "terminal prompts disabled" where it cannot ask.
- A person whose `PATH` lacks `~/.local/bin` adds it once to their shell
  profile before a terminal finds `epicenter`; Git's configuration does not
  depend on it.
- The link is per person: each account on one Mac has its own, pointed by
  its own launches.
- A development build's Git configuration names the same link, which the
  release build keeps pointed at the bundle; with no release build on the
  machine, it points at nothing until one launches.

## Considered alternatives

- **The bundle's own path (`process.execPath`) in the configuration.** It
  breaks when the app moves, and under App Translocation it names a path
  that disappears when the app quits.
- **Bare `epicenter`, found on `PATH`.** A Git client started from the
  Finder gets launchd's `PATH`, which lacks `~/.local/bin` (ADR-0559).
- **A per-user link under `<dataDir>/bin`, with `/usr/local/bin/epicenter`
  linked to it.** Two links and two refreshers, and the `PATH` link needs
  `sudo`, is shared by every account, and points into one person's
  `~/Library`.
- **A copy of the binary instead of a link.** It survives an uninstall, but
  costs about 79 MB per person, and Git keeps running a binary that mints
  tokens after the person removed Epicenter.
