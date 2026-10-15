# 0566. Plain git merges an Epicenter folder's files by kind through an opt-in merge driver

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at its command list: it adds the top-level folder command `epicenter merge-driver <dir>`, which Git also runs with four arguments.
- **Relates:** [ADR-0559](0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md) (all desktop Git runs in the CLI; Sync never runs `git merge`), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (`mergeFile`, the one merge by kind).
- **Built:** `epicenter merge-driver` (`packages/cli/src/merge-driver.ts`) over `gitMergeKind` and `mergeForGit` (`packages/folder/src/merge-driver.ts`) and `markConflicts` (`packages/folder/src/git/merge-lines.ts`); the configuration written by `epicenter merge-driver <dir>` and by `epicenter sync <dir> --remote <url>`.
- **Unbuilt:** a fallback to Git's text merge when the configured binary has moved or been removed; `sync --to` and `clone` writing the configuration, since neither command is built.

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
                       merge.epicenter.driver = '<absolute path of this binary>' merge-driver -- %O %A %B %P
```

Nothing is committed. A committed `.gitattributes` could not define the
driver anyway, and the folder engine refuses a committed `merge=` attribute
(`mergeAttribute`), so a clone keeps Git's text merge until it is configured
on that machine. The path is absolute because a Git client started from the
Finder gets launchd's `PATH` (ADR-0559). The engine's own Sync is unchanged:
it never runs `git merge`, and its `git check-attr` calls ask only for the
attributes that normalize bytes, not `merge`.

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

**The CLI writes the configuration** when a person runs
`epicenter merge-driver <dir>`, and after a sync that connects a remote
(`sync --remote`, which the desktop app runs). A failure there is a line on
stderr, not a failed sync, since Git's text merge loses nothing.

## Consequences

- Terminal `git pull`, agents, and Git clients merge a configured folder
  with the rules saves and Sync use, and conflicts look like Git's own.
- Each file both sides changed costs one start of the CLI: 37 ms median for
  the compiled binary on macOS arm64, against 27 ms for `--version` and
  9 ms for `git merge-file`. A merge where both sides changed 100 rows took
  4.07 seconds.
- If the configured binary is gone, Git records a conflict for every file
  both sides changed and keeps our version without markers, even where its
  text merge would have succeeded. Nothing is lost, but the person resolves
  each by hand until they reconfigure or remove the entry.
- A machine or clone that is not configured, and GitHub's merges, still
  merge these files as text.

## Considered alternatives

- **`epicenter sync <dir> --merge-driver`.** Configuring would also commit,
  fetch, and push, and fails on a folder with no remote.
- **A committed `.gitattributes` line.** It cannot define the driver,
  every clone without the configuration would see an undefined driver, and
  the engine refuses a committed `merge=` attribute.
- **Running the driver for Sync.** It would cost a process per file and
  still need the review path to re-derive units; Sync keeps merging in
  process (ADR-0559).
- **A shell wrapper that falls back to `git merge-file` when the binary is
  missing (exit 127).** It is better for the missing-binary case and puts
  shell syntax in the configuration; it is left unbuilt until that case
  matters.
