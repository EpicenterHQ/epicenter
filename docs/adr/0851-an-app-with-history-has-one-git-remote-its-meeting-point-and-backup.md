# 0851. An app with history has one Git remote, its meeting point and its backup

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at `epicenter sync`, which is removed: Git and the push after each commit do its work.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md), [ADR-0850](0850-every-writer-commits-exactly-what-it-wrote.md), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (`origin`).
- **Unbuilt:** the push after each commit and "behind origin" in the listing. `epicenter sync` is built and is to be deleted.

## Context

Earlier records gave each app a meeting point chosen by placement, a separate
backup, and an encrypted remote that was dropped. A later draft had your
Epicenter pull before every run and merge when the remote had moved, which
merged into a folder the person was editing on the same Mac and paid a network
fetch on every call.

## Decision

**An app with history has exactly one Git remote, `origin`, and it is both the
place copies meet and the backup.** A private GitHub repository now; Epicenter
Cloud later; any Git host works. An app with no history yet (ADR-0852's first
rung) has no remote.

- **`epicenter` never pulls and never merges.** After each commit it makes, it
  pushes fast-forward only, and only when the branch tracks a remote branch. A
  worktree branch with none is never pushed. When the push cannot fast-forward,
  or the network is down, the commit stays local and leaves with a later push;
  Git's unpushed commits are the only queue.
- **The listing says when a copy is behind `origin`.** Deploying code or taking
  in another computer's changes is a pull on that computer by the person or
  their agent.
- **A program that commits what it wrote pushes the same way.** Whispering also
  pulls with `--rebase` and pushes when it starts and when the network returns,
  skipping the pull, and saying so, when the folder has uncommitted edits.
- A person or agent pulls and pushes any clone with Git or a Git-aware editor. A
  cloud agent clones from the remote and pushes a branch; a person merges it.
- Who can read an app: whoever holds a clone, your Epicenter, and the remote's
  host. Epicenter builds no encryption.

## Consequences

- Deleted: `epicenter sync`, pulling before a run, merging into a working tree, a
  meeting point per app, a backup separate from the remote, and backup detection.
- A change pushed from the laptop reaches your Epicenter's runs only after a pull
  there.
- An app without a remote still runs; it has no backup until one is added.

## Considered alternatives

- **Pull before every run, merging when the remote moved.** Merges into a tree
  the person is editing, fails reads on conflicts, and fetches on every call.
- **Your Epicenter as the meeting point, the remote as a backup.** Pushes into a
  folder someone may be editing, and two remotes per app.
- **An end-to-end encrypted remote.** Re-uploads history or needs key
  management, and rules out hosted runs.
- **Keep `epicenter sync`.** A loop over repositories that Git and editors cover.
