# 0940. Git stores the home, and Epicenter does not wrap it

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) on checkpoints: Epicenter has no checkpoint command, and the home commits itself. [ADR-0937](0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md) on `epicenter routines`: bare `epicenter` lists routines. [ADR-0939](0939-what-stays-on-this-computer-lives-in-an-apps-local-folder.md) on the checkpoint's refusal: Git's ignore rules are the only guard. [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) on `init --from`: a home comes back with `git clone`.
- **Relates:** [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one serve runs every action; no lock anywhere).

## Context

`epicenter checkpoint` staged the home's files, refused several kinds of
path, committed, and pushed with a deadline: about 430 lines and 540 of
tests around `git add`, `git commit` and `git push`. `epicenter export`
checkpointed before it exported. `epicenter init --from` cloned a home and
installed its apps. `epicenter routines` listed the schedule. A root lock and
an export lock serialised the first two.

The owner is one technical person who uses Git. Each of these commands
restated a tool they already have, and each refusal was a second copy of a
rule Git's ignore file already holds. With one serve running every action
(ADR-0936) and routines started from a cron line (ADR-0937), nothing in
Epicenter needs to commit.

## Decision

**Epicenter runs actions and serves pages. Git stores the home, and
Epicenter does not wrap Git.**

- **No Epicenter command commits, stages or pushes.** `epicenter checkpoint`
  is deleted, with its push deadline and its refusals.
- **The home commits itself.** `init` writes `routines/checkpoint.md`, which
  runs a script in the home's `scripts/` folder every five minutes, one run at a time. The
  script is about ten lines of `sh` and belongs to the home: it waits out a
  merge, rebase, revert or cherry-pick, runs `git add -A`, refuses while a
  nested Git repository is staged, commits when something is staged, and
  pushes when there is an origin.
- **Git's ignore file is the only guard.** What must not be committed is
  named in the root `.gitignore`: `/apps/*/local/` and, until the old names
  are gone, `*.local` and `*.local.*` (ADR-0939). Nothing in Epicenter
  refuses a path.
- **`epicenter export` reads.** It exports what `HEAD` holds and refuses an
  app whose `code/` has uncommitted changes, saying to commit first.
- **Bare `epicenter` reports.** It lists apps and their actions, each
  routine with its schedule and next occurrence or why its file is refused,
  and one line from Git: how long ago the last commit was, how many files
  are uncommitted, how many commits are not on origin, and any Git
  repository nested under `apps/`. It has no side effects and never starts
  serve. `epicenter routines` is deleted.
- **A home comes back with `git clone`**, then `epicenter install` for the
  packages Git ignores. `init --from` is deleted.
- **Epicenter takes no lock.** The root lock and the export lock are gone
  with the commands they guarded. A commit takes Git's own index lock. The
  home's routine runs its script under `lockf`, which is the home's choice.
- **`epicenter check` stays a platform command.** It reads every app's
  records against their declarations and is not an action of each app.

## Consequences

- About 1,500 lines leave the CLI: `checkpoint.ts`, its tests, the push
  deadline in `git.ts`, export's commit step, and the restore path of
  `init`.
- A token is kept out of a commit by one line in a file the owner can edit.
  Deleting that line, or `git add -f`, commits it, and nothing objects.
- A home whose routine file is removed has no history and no backup, and
  bare `epicenter` is where that shows: "last commit 3 days ago; 212 files
  uncommitted".
- A nested Git repository is refused by the home's script, not by Epicenter,
  and stays staged after the refusal. Bare `epicenter` names it.
- The script is the home's file, so two homes can differ, and a fix to the
  script `init` writes does not reach a home made earlier.
- `/usr/bin/lockf` is on macOS. A Linux home starts the routine's command
  with `flock -n`.
- `export` runs `git status`, which can run a Git LFS filter that writes
  inside `.git`. Epicenter itself writes nothing.

## Considered alternatives

- **Keep `checkpoint` and trim it.** Every part that remained was a Git
  command with a different name.
- **Serve commits on a clock.** ADR-0937 removed serve's clock so that one
  thing, routines, is periodic.
- **Each app's `local/` holds a `.gitignore` of `*`, written when Epicenter
  first makes the folder, and the root line goes.** An app that makes
  `local/` itself with `node:fs` or SQLite, as Vault and Mail do, would get
  no such file, and `git add -A` would commit its databases. Closing that
  from the runtime means checking after every call.
- **A check action per app in place of `epicenter check`.** It would put the
  same read in eleven action tables to make it reachable over MCP, which a
  platform command already is from a shell.
- **Bare `epicenter` starts serve.** A command that lists things would start
  a long-running process in whichever shell ran it (ADR-0936).
