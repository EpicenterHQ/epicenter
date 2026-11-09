# 0851. An app with history has one Git remote, its meeting point and its backup

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at `epicenter sync`, which stays as the one command that commits what is left, pulls with `--rebase`, and pushes.
- **Relates:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (`origin`).
- **Unbuilt:** `epicenter sync` and Whispering's own sync. Built 2026-11-09 and to be deleted: the fast-forward push after each commit `epicenter` made, the fetch after a refused push, and ahead and behind `origin` in the listing (`packages/cli/src/push.ts`).

## Context

Earlier records gave each app a meeting point chosen by placement, a separate
backup, and an encrypted remote that was dropped. A later draft had your
Epicenter pull before every run and merge when the remote had moved, which
merged into a folder the person was editing on the same Mac and paid a network
fetch on every call. The first draft of this record then pushed after every
commit `epicenter` made; once a run stopped committing (ADR-0850), nothing was
left to push after.

## Decision

**An app with history has exactly one Git remote, `origin`, and it is both the
place copies meet and the backup.** A private GitHub repository now; Epicenter
Cloud later; any Git host works. An app with no history yet (ADR-0852's first
rung) has no remote.

- **`epicenter sync [<app>]` is the only command that touches a remote.** For
  each app, or the one named, from its folder: `git add -A -- .` and a commit
  `sync: <app> (<n> files)` when anything changed, then
  `git pull --rebase --autostash`, then `git push`. An app inside a larger
  repository commits only its own folder but pulls and pushes that whole
  repository, so other uncommitted files there are set aside and put back by
  `--autostash`; when they cannot be put back, Git keeps them in its stash and
  `sync` says so. A rebase that stops on a conflict is aborted
  (`git rebase --abort`); the commits stay local, and `sync` names the app and
  prints `git -C <folder> pull --rebase` as the next step. Offline, it commits
  and says it could not push. Which branch it pushes is Git's: the upstream and
  `push.default` the clone already has, so a branch that tracks nothing is
  committed and not pushed. It reports how far each app is ahead of and behind
  `origin` afterwards.
- **Copies never talk to each other.** The Mac Studio, the laptop, and anyone a
  repository is shared with each sync with `origin` and never with one another,
  so no copy has to be awake for another to sync.
- **Who runs `sync` is the caller's choice:** the person, an agent (the MCP tool
  `sync`), a screen's button through `serve`, or a launchd job on each copy.
  `epicenter` schedules nothing (ADR-0849).
- **The listing reads nothing from Git.** How far a copy is behind is in what
  `sync` reports.
- **A program that writes the folder syncs the same way.** Whispering commits
  with Git and pulls with `--rebase` and pushes as `sync` does.
- A person or agent pulls and pushes any clone with Git or a Git-aware editor. A
  cloud agent clones from the remote and pushes a branch; a person merges it.
- Who can read an app: whoever holds a clone, your server, and the remote's
  host. Epicenter builds no encryption.
- A backup on another host is a second push URL on `origin`, never a second
  meeting point.

## Consequences

- Deleted: pushing after each commit, the fetch after a refused push, ahead and
  behind in the listing, pulling before a run, merging into a working tree, a
  meeting point per app, a backup separate from the remote, and backup
  detection.
- A change made on the laptop reaches the Mac Studio at the next `sync` on each.
- A rebase on the daily Mac can change a file under an open editor buffer. A
  conflict never leaves the folder mid-rebase.
- An app without a remote still runs and commits; it has no backup until one is
  added.

## Considered alternatives

- **Pull before every run, merging when the remote moved.** Merges into a tree
  the person is editing, fails reads on conflicts, and fetches on every call.
- **Your server as the meeting point, the remote as a backup.** Pushes into a
  folder someone may be editing, and two remotes per app.
- **An end-to-end encrypted remote.** Re-uploads history or needs key
  management, and rules out hosted runs.
- **Push after each commit `epicenter` makes (this record's first draft, built
  2026-11-09).** Nothing is left to push after once a run makes no commit, and a
  slow push sat behind every run.
- **No `epicenter sync`, Git and editors only.** A caller without a shell, such
  as Claude Desktop or a screen, could never commit or push.
