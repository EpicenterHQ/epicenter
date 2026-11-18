# 0955. No command makes or copies an app

- **Status:** Proposed
- **Date:** 2026-11-18
- **Supersedes:** [ADR-0929](0929-new-copies-an-apps-code-from-a-folder-in-git-or-a-folder-on-github.md): `new --from` no longer exists. [ADR-0911](0911-export-copies-an-apps-committed-code-into-a-refreshable-directory.md): `export` no longer exists.
- **Amends:** [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) at "`epicenter export` reads": no command exports, so the `epicenter` command runs no Git.
- **Relates:** [ADR-0904](0904-copying-is-the-only-way-to-take-an-apps-code.md) (copying is the only way to take an app's code; the owner does the copying), [ADR-0943](0943-epicenters-core-invariants.md) (rule 6), [ADR-0958](0958-no-command-makes-an-epicenter.md) (no command makes an Epicenter).

## Context

`epicenter new <name> --from <source>` copied one committed app folder into a
home (ADR-0929). It took a path or `owner/repo/folder#ref`, cloned the source,
refused uncommitted local code, filtered paths, checked files out with LFS
forced on, renamed the copy's package and wrote `SOURCE.md`. That was about
400 lines, and no one outside this repository took an app with it. It was
removed first.

Two commands that set an app up were left in `COMMANDS`
(`d413cc7a78:packages/cli/src/commands.ts`):

- `epicenter new <name>` (`d413cc7a78:packages/cli/src/new.ts`, 75 lines)
  wrote `apps/<name>/code/` with `.gitignore`, a `package.json` named
  `<name>` and an `epicenter.ts` whose `defineApp` had no actions, beside an
  empty `data/`. It printed `Run: cd <home> && bun install && bun run build`.
- `epicenter export <app> <directory>` and `epicenter export --all
  <directory>` (ADR-0911; `d413cc7a78:packages/cli/src/export.ts`, with
  `code-copy.ts` and `git.ts`, 600 lines) copied the code of the commit
  `HEAD` names into a directory it owned. It ran `git rev-parse`,
  `git read-tree`, `git ls-files`, `git checkout-index` and `git lfs`. It
  refused a destination without its `.epicenter-export.json` marker, a link
  that left the app's `code/`, and an app whose `code/` had uncommitted
  changes.

An app is a folder of plain files. `new` wrote three files of fixed text,
and `export` copied a folder. The owner, or the agent working for them,
writes files and copies folders without a command. Neither step needs an
app's declaration or the running serve, so by rule 6 of ADR-0943 Epicenter
does not wrap them, and ADR-0958 had already removed `init`
on that rule.

## Decision

**No command makes an app, and none copies an app's code into an Epicenter
or out of one. An app is a folder its owner writes: `apps/<name>/code/` with
`epicenter.ts`, a `package.json` named `<name>` and a `.gitignore`, beside
`data/`.**

- `COMMANDS` in `packages/cli/src/commands.ts` holds `check` and `serve`.
  `new` and `export` are not in it.
- "What an app holds" in `packages/cli/README.md` lists those files. It is
  the only description of a new app. The README's quick start has one line
  that fetches the Writing example; it gives no general procedure for
  copying or publishing an app.
- `epicenter` reads the folder and reports what is wrong with it. The bare
  `epicenter` lists an app that does not load, with its problems, and
  `epicenter check` lists the records that do not fit.
- An Epicenter with no apps says
  `No apps yet. An app is apps/<name>/code/epicenter.ts`.
- The `epicenter` command starts neither Git nor Bun. The one program it
  starts is a routine's own `run`, in `packages/cli/src/routines.ts`.
- Taking an app's code stays a copy that nothing merges (ADR-0904). The
  owner makes it with their own tools.

## Consequences

- Removed: `new.ts`, `export.ts`, `code-copy.ts` and `git.ts` (675 lines),
  `new.test.ts` and `export.test.ts` (690 lines), and two entries in
  `COMMANDS`.
- Given up with `export`: the refusal to replace a directory that is not an
  earlier export, the refusal of a link that leaves `code/`, the refusal of
  uncommitted code, and the filter that left out `node_modules`, `ui/dist`
  and `.DS_Store` even when tracked. A person who publishes an app's code
  checks each by hand.
- Given up with `new`: a name is no longer checked before its folder exists.
  The bare `epicenter` reports a folder whose name cannot name an app after
  it is made, and nothing reports two folders whose names differ only by
  case.
- `new` and `export` are no longer reserved words: an app may be named
  either.
- `.epicenter-export.json` marks nothing. The two under `examples/` are
  deleted.
- What is copied is what is on disk or in the downloaded ref, and nothing
  records where a copy came from.
- A copy without `data/` works: an app's records folder is made when it is
  first written.
- A sharing command can return when people other than the owner take apps,
  shaped by what they trip on.

## Considered alternatives

- **`new` keeps making a blank app.** It was three files of fixed text that
  the README's table now states, and one more word no app could be named.
- **`export` stays for its safety checks.** ADR-0943's old rule 7 had named it
  an exception, because Git alone refuses neither a link that leaves the
  folder nor uncommitted code. It was 600 lines and the only reason the
  command ran Git, for a step the owner reviews before pushing.
- **The README teaches `cp -R` and `curl | tar` in place of the commands.**
  A recipe is a procedure to keep true, for steps the owner's agent already
  knows.
