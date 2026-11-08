# 0851. Each app has one Git remote, its meeting point and its backup

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at `epicenter sync`, which is removed: Git and your Epicenter's pull and push do its work.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md), [ADR-0850](0850-running-an-action-makes-one-commit-or-nothing.md), [ADR-0852](0852-an-app-is-a-git-repository-of-files-and-actions.md) (the remote is `origin`).
- **Unbuilt:** pushing after every commit `epicenter` makes, and pulling before a run on your Epicenter. `epicenter sync` is built and is to be deleted.

## Context

Earlier records gave each app a meeting point chosen by placement (the box for
Mail, GitHub for the vault), a separate backup, and an encrypted remote that was
dropped. With one commit rule everywhere (ADR-0850), every folder of an app is
an ordinary clone, and one remote can do all three jobs.

## Decision

**Each app's repository has exactly one Git remote, `origin`, and it is both
the place copies meet and the backup.** A private GitHub repository now;
Epicenter Cloud (a repository on Cloudflare Artifacts) by default later; any Git
host works.

- `epicenter` pushes after each commit it makes, wherever it runs, when the
  branch tracks a remote branch; a worktree branch with none is never pushed.
  If the remote has moved it merges first. Offline, or when the merge would
  touch a file with uncommitted edits or conflict, the commit stays local and
  leaves with the next push; Git's unpushed commits are the only queue.
- Your Epicenter also pulls before each run.
- A program that commits what it wrote, such as Whispering (ADR-0853), pushes
  the same way.
- A person or agent pulls and pushes a clone with Git, or with a Git-aware
  editor. Pushing an app's code is deploying it: your Epicenter runs what it
  pulled.
- A cloud agent clones from the remote and pushes a branch; a person merges it.
- Who can read an app: whoever holds a clone, your Epicenter, and the remote's
  host. Epicenter builds no encryption.

## Consequences

- Deleted: `epicenter sync`, a meeting point per app, a backup separate from the
  remote, and backup detection.
- If your Epicenter's pull meets a conflict, the run fails and names it; the
  person resolves it in a clone and pushes.
- An app without a remote still runs; it has no backup until one is added.

## Considered alternatives

- **Your Epicenter as the meeting point, the remote as a backup.** Pushes into a
  folder on the Mac that someone may be editing, and two remotes per app.
- **End-to-end encrypted remote (`git-remote-gcrypt` or our own).** Re-uploads
  history or needs key management, and rules out hosted runs.
- **Keep `epicenter sync`.** A loop over repositories that Git and editors
  already cover.
