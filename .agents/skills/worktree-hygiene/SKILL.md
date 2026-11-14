---
name: worktree-hygiene
description: Reap local Git worktrees and branches once their work is on GitHub, with `bun run worktrees`. Use when cleaning up worktrees or local branches, or deciding whether one is safe to delete, not when creating branches or commits.
metadata:
  author: epicenter
  version: '2.0'
---

# Worktree Hygiene

> **Related Skills**: [git](../git/SKILL.md) for working inside a worktree.

A local copy is disposable once its work is reachable from GitHub: on `origin/main`, in a PR's head, or pushed as `backup/<branch>`. Git history keeps it findable, not the local branch. [`scripts/worktree-audit.ts`](../../../scripts/worktree-audit.ts) owns the mechanics and states the rule exactly; this skill holds the judgment it cannot make.

## Procedure

1. Run `bun run worktrees`. It fetches, then prints every local branch and worktree with its state, dirty file count, and proof.
2. Judge each row the script cannot decide (below), then show the owner the table and what you propose for each row.
3. With approval, run `bun run worktrees --backup <branch…>` for abandoned `local-only` or `pushed` branches, then `bun run worktrees --reap <branch…>` for the approved names. Reap re-checks each branch at deletion and refuses anything uncovered or dirty.
4. Run `bun run worktrees` again. Sessions create and switch worktrees continuously, so the second listing is the result.

## What the script leaves to you

- **Dirt.** It refuses any worktree with changed or untracked files. Build output (`dist/`, `target/`, `build-desktop/`) is throwaway; delete it by hand, then reap. Modified source or a unique untracked file is real work: commit it to a branch and back that up first.
- **Liveness.** A clean, covered worktree may belong to a session that is still working, and a `local-only` branch may be today's work. Check the commit age and the running sessions; never reap a worktree another live session owns.
- **Bases.** Keep a `base/*` branch another session started from until that session's PR merges.
- **Local `main`.** The script reports how far `main` is from `origin/main` and never moves it. If it has commits or changes of its own, back them up and ask the owner separately before `git branch -f main origin/main`: discarding work on `main` is its own decision.
- **Remote branches and PRs.** The script never deletes remote refs. Delete a merged PR's branch on GitHub by hand; close an open PR whose content reached `main` under other hashes with a comment naming the commit that landed it.

Reaping is destructive (`AGENTS.md`), so `--reap` runs only on names the owner approved. `--backup` only adds refs and needs no gate.

If `git worktree remove` leaves `Directory not empty` because of ignored files, it has already de-registered the worktree: run `git worktree prune`, then `rm -rf` the folder.
