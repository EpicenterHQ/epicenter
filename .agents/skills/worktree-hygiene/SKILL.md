---
name: worktree-hygiene
description: Delete local Git worktrees and branches once their work is on GitHub, with `bun run worktrees`. Use when cleaning up worktrees or local branches, or deciding whether one is safe to delete, not when creating branches or commits.
metadata:
  author: epicenter
  version: '2.0'
---

# Worktree Hygiene

A local copy is disposable once its work is on GitHub: on `origin/main`, or pushed as `backup/<branch>`. Git history keeps it findable, not the local branch. [`scripts/worktree-audit.ts`](../../../scripts/worktree-audit.ts) does the checking and deleting; this skill is the judgment it cannot make.

Run `bun run worktrees` to list every local branch and worktree as `covered` or `UNCOVERED`. After the owner approves names, `bun run worktrees reap <branch…>` deletes them; it pushes an uncovered branch to `backup/<branch>` first and refuses a worktree with changed or untracked files. List again afterward: sessions create and switch worktrees continuously.

## What the script leaves to you

- **Whether anyone is using it.** The script cannot see sessions. A clean, covered worktree may belong to a session that is still working, and an `UNCOVERED` branch with a recent commit is usually today's work. Never reap a worktree a live session owns, and keep a `base/*` branch another session started from until that session's PR merges.
- **Changed files.** Build output (`dist/`, `target/`, `build-desktop/`) is throwaway: delete it by hand, then reap. Modified source or a unique untracked file is real work: commit it to the branch first.
- **Local `main`.** The listing shows how far `main` is from `origin/main`; the script never moves it. If `main` has its own commits or changes, push them to a `backup/` branch and ask the owner before `git branch -f main origin/main`. Discarding work on `main` is its own decision.
- **Detached worktrees.** The listing shows them, and reap takes branch names only. Remove a covered, clean one with `git worktree remove <path>`.
- **GitHub.** The script never deletes a remote ref or closes a PR.
