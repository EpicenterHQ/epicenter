# 0851. An app with history has one Git remote, its meeting point and its backup

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at `epicenter sync`, which stays as the one command that commits what is left, pulls with `--rebase`, and pushes.
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (`origin`), [ADR-0862](0862-notes-merge-field-by-field-and-every-conflict-is-listed-for-repair.md) (merging), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one copy, the mirror, and pushes into your server).
- **Unbuilt:** Whispering's sync, `sync` on your server pushing without pulling, and the `push-to-checkout` setup of your server's repositories. Built: `epicenter sync` (`packages/cli/src/sync.ts`).

## Context

Earlier records gave each app a meeting point chosen by placement, a separate
backup, and an encrypted remote that was dropped. A later draft had your
server pull before every run and merge when the remote had moved, which merged
into a folder the person was editing on the same Mac and paid a network fetch on
every call. Pushing after every commit `epicenter` made left nothing to push
once a run stopped committing (ADR-0850). Your server now holds the one copy of
each app, and only a program that must work offline keeps another (ADR-0864).

## Decision

**An app with history has exactly one Git remote, `origin`.**

| Copy | Its `origin` | Which is |
| --- | --- | --- |
| your server's `~/Epicenter/<app>` | the app's GitHub repository | the backup, never pulled from |
| a program's copy on another Mac (`~/Epicenter/whispering` on the laptop) | your server over SSH, `studio:Epicenter/whispering` | where the copy meets the one copy |

An app with no history yet (ADR-0852's first rung) has no remote.

- **`epicenter sync [<app>]` is the only command that touches a remote.** For
  each app, or the one named, from its folder: `git add -A -- .` and a commit
  `sync: <app> (<n> files)` when anything changed, then on a copy
  `git pull --rebase --autostash`, then `git push`. On your server it does not
  pull, so the server's copy never merges (ADR-0864). An app inside a larger
  repository commits only its own folder but pulls and pushes that whole
  repository, so other uncommitted files there are set aside and put back by
  `--autostash`; when they cannot be put back, Git keeps them in its stash and
  `sync` says so. A rebase that stops on a conflict is aborted
  (`git rebase --abort`), the commits stay local, and `sync` says why. Offline,
  it commits and says it could not push. Which branch it pushes is Git's: the
  upstream and `push.default` the clone already has, so a branch that tracks
  nothing is committed and not pushed. It reports how far each app is ahead of
  and behind `origin` afterwards.
- **A push from a copy lands in your server's working tree.** The server's
  repositories set `receive.denyCurrentBranch updateInstead` and a
  `push-to-checkout` hook, so a push is refused only when it touches a file
  with uncommitted changes there (ADR-0864).
- **Copies talk only to your server.** Whispering on the laptop and on another
  Mac each sync with the server and never with one another, so no copy has to
  be awake for another to sync.
- **Who runs `sync` is the caller's choice:** the person, an agent, or a
  program after it writes. Nothing runs it on a timer (ADR-0849).
- **The listing reads nothing from Git.** How far a copy is behind is in what
  `sync` reports.
- **A program that writes its copy syncs the same way.** Whispering commits
  with Git, pulls from your server with `--rebase`, and pushes.
- A person or agent pulls and pushes any clone with Git or a Git-aware editor. A
  cloud agent clones the GitHub repository and pushes a branch; a person merges
  it on your server.
- Who can read an app: whoever holds a clone, your server, and GitHub.
  Epicenter builds no encryption.
- A backup on another host is a second push URL on `origin`, never a second
  meeting point.

## Consequences

- Deleted: pushing after each commit, the fetch after a refused push, ahead and
  behind in the listing, pulling before a run, merging into your server's
  working tree, a meeting point per app, a backup separate from the remote, and
  backup detection.
- A recording made on the laptop reaches your server at Whispering's next push.
- A push can change a file under an open editor buffer on your server; a rebase
  can do the same on a copy. A conflict never leaves a folder mid-rebase.
- An app without a remote still runs and commits; it has no backup until one is
  added.

## Considered alternatives

- **Pull before every run, merging when the remote moved.** Merges into a tree
  the person is editing, fails reads on conflicts, and fetches on every call.
- **GitHub as the copies' remote, your server pulling to see what they
  pushed.** A timer or webhook before the server sees a push, and the server's
  copy merges unattended, leaving any conflict in the folder every agent reads
  (ADR-0864).
- **Cloudflare Artifacts as every copy's meeting place.** A copy on every
  device, which ADR-0864 does not keep.
- **An end-to-end encrypted remote.** Re-uploads history or needs key
  management, and rules out hosted runs.
- **Push after each commit `epicenter` makes.** Nothing is left to push after
  once a run makes no commit, and a slow push sat behind every run.
- **No `epicenter sync`, Git and editors only.** Edits made by hand or by an
  editor would have no one command that commits, pulls, and pushes them.
- **`sync` as an MCP tool.** It was one while a caller without a shell, such
  as Claude Desktop or a view, had no other way to commit or push. Every write
  now commits itself and `epicenter serve` pushes after it (ADR-0850), so the
  tool only committed what someone left by hand, which is the terminal's job.
