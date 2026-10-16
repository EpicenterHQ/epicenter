# 0566. Plain git merges an Epicenter folder's files by kind through a merge driver every connect and clone configures

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at its command list: it adds the top-level folder command `epicenter merge-driver <dir>`, which Git also runs with four arguments; and at `install-command`, which points the one command link `~/.local/bin/epicenter` at the running binary, never with `sudo`.
- **Relates:** [ADR-0567](0567-epicenter-ships-for-macos-only-for-now.md) (macOS only), [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md) (all desktop Git runs in the CLI; Sync never runs `git merge`), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (`mergeFile`, the one merge by kind).
- **Built:** `epicenter merge-driver` (`packages/cli/src/merge-driver.ts`) over `gitMergeKind` and `mergeForGit` (`packages/folder/src/merge-driver.ts`) and `markConflicts` (`packages/folder/src/git/merge-lines.ts`); the configuration written by `epicenter merge-driver <dir>`, by `epicenter sync <dir> --to <namespace>/<name> | <url>`, and by `epicenter clone`; the command link `~/.local/bin/epicenter` (`AppPaths.commandLink`, `install-command` in `packages/cli/src/install-command.ts`, and the launch call `spawn_command_link_refresh` in `apps/epicenter/src-tauri/src/cli.rs`).
- **Unbuilt:** Settings showing that a launch under App Translocation, or a regular file at `~/.local/bin/epicenter`, left the link alone, which today only the log records; Settings telling a person whose `PATH` lacks `~/.local/bin` to add it.

## Context

Epicenter's Sync merges a folder's files by kind with `mergeFile`
(ADR-0551): a row by field and body line, `kv.json` by key, other text by
line. It does so in TypeScript over objects and never runs `git merge`
(ADR-0559). A person, an agent, or a Git client that runs `git pull` or
`git merge` in the same folder gets Git's line merge instead. Two edits to
different fields on neighboring lines of one row conflict there, two keys
added side by side in `kv.json` conflict, and a row that merges cleanly by
line is never checked against its table.

Git lets a repository merge a path with a program: an attribute
`merge=<name>` selects a driver, and `merge.<name>.driver` in Git's
configuration defines it. Git reads the definition only from configuration,
never from the repository's files, so a clone cannot make anyone run a
program. The driver gets the base, ours, and theirs as temporary files
(`%O`, `%A`, `%B`) and the path (`%P`), runs from the top of the working
tree, leaves its result in `%A`, and exits 0 for a clean merge and non-zero
for a conflict. An exit above 128 is a crash that stops the whole merge.
Git calls it only for paths both sides changed, including a file both sides
added (with an empty `%O`) and binary files.

## Decision

**`epicenter merge-driver` has two forms.**

```txt
epicenter merge-driver <dir>                      configure the folder's repository
epicenter merge-driver -- %O %A %B %P             what Git runs for one file
```

It is a top-level folder verb that takes a path, as ADR-0558's grammar
requires, and is listed in `--help`. Configuring is its own command rather
than a `sync` option, because it needs no commit, fetch, or push, and a
folder without a remote can be configured too.

**The configuration lives only in the repository's own Git directory.**

```txt
.git/info/attributes   * merge=epicenter
.git/config            merge.epicenter.name   = Epicenter folder merge
                       merge.epicenter.driver = '/Users/<you>/.local/bin/epicenter' merge-driver -- %O %A %B %P
```

Nothing is committed. A committed `.gitattributes` could not define the
driver anyway: a driver's command lives only in Git configuration, so a clone
never runs a program its repository names, and it merges as its committed
attributes say, text by default, until it is configured on that machine.
The engine reads no `merge` attribute. `.git/info/attributes` takes
precedence over every committed `.gitattributes`, so once a repository is
configured, `* merge=epicenter` decides every path's merge whatever a
committed file says. The engine's own Sync is unchanged: it never runs
`git merge`, and its `git check-attr` calls ask only for the attributes that
normalize bytes, not `merge`.

**Every Git configuration Epicenter writes runs one command link,
`~/.local/bin/epicenter`, which each launch points at the running binary.**
That covers `merge.epicenter.driver` and the global credential helper
(ADR-0565). The link is `resolveAppPaths().commandLink`
(`packages/cli/src/app-paths.ts`), one per person whichever build runs:

```txt
~/.local/bin/epicenter -> /Applications/Epicenter.app/Contents/MacOS/epicenter-cli
```

The configured path is absolute because a Git client started from the Finder
gets launchd's `PATH` (ADR-0559), and single-quoted for `sh`. A terminal
reaches the same link on `PATH` once a person adds `~/.local/bin` to it, one
line in their shell profile.

- `epicenter install-command` points the link at the running binary's real
  path, as a link staged beside it and renamed over it. It never needs
  `sudo`. A regular file at the link's path is someone else's and is refused.
- A release build runs `epicenter install-command --json` at every launch
  (`spawn_command_link_refresh`). A development build runs the CLI from
  source and leaves the link to the release build.
- Every command that writes Git configuration names the link and makes
  nothing (`AppPaths.commandLink`), whether it runs from the bundle, the link, or
  source, so a development run never writes a checkout into the global
  configuration.
- A binary under macOS's App Translocation
  (`/private/var/folders/.../AppTranslocation/`) leaves the link as it is: its
  path disappears when the app quits. The command says so, and the launch
  call exits 1 and is logged.
- A `git` the CLI itself spawns may name the running binary's own path, which
  exists as long as the process does.

**The `--` keeps the path a path.** Git substitutes `%P` as one quoted
argument, but the CLI's parser would still read a file at the repository
root named `--help`, `-h`, or `--version` as that option. It would print
help and exit 0, and Git would take our version as a clean merge, dropping
theirs. After `--`, every token is a positional.

**The driver merges with `mergeFile`.** It finds the file's kind from the
nearest `epicenter.json` above `%P` in the working tree, so a data folder
inside a larger repository works too, and reads an empty `%O` as no base,
so two rows added under one name merge field by field.

- A clean merge is written over `%A`, a row in its canonical form, and the
  driver exits 0.
- When units compete, `%A` holds each side's merge, that side winning every
  competing unit, with `<<<<<<< ours`, `=======`, and `>>>>>>> theirs`
  around the lines where the two differ: the field's line for a field, the
  key's lines for a setting, the body lines for a body. The driver exits 1.
  Git records the conflict and keeps stages 1, 2, and 3, from which
  Epicenter's Sync re-derives the units for review.
- When each side reads as a row but their merge does not, the whole file is
  one marked conflict, so an invalid row is never written as a clean merge.

**Anything else falls back to `git merge-file`**, the result Git gives with
no driver: a path in no data folder, a declaration that does not read, a
version that is not text (a binary file stays ours, as a conflict), and any
failure of the driver's own. The driver's exits are 0 and 1 only, and it
never reaches the network.

**Connecting configures the driver; nobody opts in.** The CLI writes the
configuration after every sync that connects a remote (`sync --to`,
which the desktop app runs with a URL) and after every `epicenter clone`, and when a person runs `epicenter merge-driver <dir>`. A repository
Epicenter neither connected nor cloned keeps Git's text merge until that
command runs. A failure to configure is a line on stderr, not a failed sync
or clone, since Git's text merge loses nothing.

## Consequences

- Terminal `git pull`, agents, and Git clients merge a configured folder
  with the rules saves and Sync use, and conflicts look like Git's own.
- Each file both sides changed costs one start of the CLI: 37 ms median for
  the compiled binary on macOS arm64, against 27 ms for `--version` and
  9 ms for `git merge-file`. A merge where both sides changed 100 rows took
  4.07 seconds.
- Moving the app breaks the driver and the credential helper only until its
  next launch, which points the command link at it again; no repository and
  no global configuration is rewritten.
- After Epicenter is uninstalled, the link points at nothing. The credential
  helper fails with `sh`'s "No such file or directory", and Git asks for a
  username, or fails with "terminal prompts disabled" where it cannot ask.
  The driver exits 127, which Git reads as a conflict: every file both sides
  changed keeps our version without markers, even where Git's text merge
  would have succeeded. Nothing is lost; the person resolves each by hand
  until they remove the entry, and `git config --unset merge.epicenter.driver`
  returns the repository to Git's text merge.
- A person whose `PATH` lacks `~/.local/bin` adds it once to their shell
  profile before a terminal finds `epicenter`; Git's configuration does not
  depend on it.
- The link is per person: each account on one Mac has its own, pointed by
  its own launches.
- A development build's Git configuration names the same link, which the
  release build keeps pointed at the bundle; with no release build on the
  machine, it points at nothing until one launches.
- A machine or clone that is not configured, and GitHub's merges, still
  merge these files as text.

## Considered alternatives

- **Configuring only when a person asks, with `epicenter merge-driver
  <dir>` or a flag.** Every folder Epicenter connects or clones would merge
  as text under `git pull` until its owner learned of the command, and the
  configuration lives in the folder's own `.git` and changes nothing
  outside it, so asking first protects nothing.
- **`epicenter sync <dir> --merge-driver`.** Configuring would also commit,
  fetch, and push, and fails on a folder with no remote.
- **A committed `.gitattributes` line.** It cannot define the driver, and
  every clone without the configuration would see an undefined driver.
- **Running the driver for Sync.** It would cost a process per file and
  still need the review path to re-derive units; Sync keeps merging in
  process (ADR-0559).
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
- **A shell wrapper in `merge.epicenter.driver` that runs `git merge-file`
  when the link points at nothing (exit 127).** It gives Git's text merge
  after an uninstall, but puts shell syntax in `.git/config` and leaves the
  credential helper failing the same way. Plain conflicts after an uninstall
  are accepted instead.
