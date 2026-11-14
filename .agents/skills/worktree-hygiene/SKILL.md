---
name: worktree-hygiene
description: Safely reap Git worktrees and branches across Epicenter harnesses once their work is on GitHub, backing up unmerged work first. Use when cleaning `git worktree list` or local branches, removing orphaned or detached worktrees, or deciding whether one is safe to delete, not when creating branches or commits.
metadata:
  author: epicenter
  version: '1.1'
---

# Worktree Hygiene

> **Related Skills**: [git](../git/SKILL.md) for branch creation, staging, and commit messages. [standalone-commits](../standalone-commits/SKILL.md) for reviewable units. [pull-request](../pull-request/SKILL.md) for merge strategy.

Five harnesses (Claude Code, Codex, Conductor, Warp, opencode) mint worktrees and branches here, and nothing reaps them, so they accumulate. The cure is to reap on close: once a branch's work is on GitHub, remove its worktree and delete the local branch in the same motion. This skill is the safe procedure for doing that, one-off or as a periodic sweep.

## The rule: covered, then deleted

A local copy is disposable once its work is reachable from GitHub. Git history is what keeps it findable, not the local branch.

```txt
covered = every commit is on origin/main          (merged, squashed, or rebased)
       OR the exact tip is on origin under backup/  (unmerged, kept for later)

reap    = covered  AND  working tree clean (or only throwaway dirt)
```

- `git merge-base --is-ancestor <branch> origin/main` proves a normal merge.
- `git cherry origin/main <branch>` with no `+` lines proves a squash or rebase merge, where the commits reached `main` under new hashes.
- `git rev-parse origin/backup/<date>/<branch>` equal to `git rev-parse <branch>` proves a backup. Any other ref on origin that contains the tip (`git for-each-ref --contains <branch> refs/remotes/origin`) also counts.

"Branch merged" alone is **not** sufficient. A covered branch routinely carries live uncommitted edits in its working tree, and `--force` destroys them. Uncommitted work is never covered: commit it to a branch first.

## Back up what is not on main

Unmerged work that nobody is actively using goes to GitHub, not to a local branch that only this machine holds. One naming scheme, a branch per original branch:

```txt
backup/<YYYY-MM-DD>/<original-branch-name>
```

```bash
bash -c '
cd <main-checkout>
list="claude/foo codex/bar"
refs=(); for b in $list; do refs+=("${b}:refs/heads/backup/2026-11-13/${b}"); done
git push -q origin "${refs[@]}" && git fetch -q origin
for b in $list; do [ "$(git rev-parse "origin/backup/2026-11-13/${b}")" = "$(git rev-parse "$b")" ] || echo "NOT BACKED UP $b"; done'
```

Run it under `bash`: in zsh, `$b:refs` reads `:r` as a path modifier and mangles every refspec. Verify every SHA before deleting anything; a push that printed nothing may still have pushed nothing.

Use branches, not tags, so a backup can be checked out, compared, and reopened as a PR the same way as any other branch.

## Audit procedure

Fetch first, then classify every local branch, including ones no worktree holds:

```bash
bash -c '
cd <main-checkout>; git fetch -q --prune origin
inuse=$(git worktree list --porcelain | awk "/^branch/{sub(\"refs/heads/\",\"\",\$2);print \$2}")
for b in $(git for-each-ref --format="%(refname:short)" refs/heads); do
  echo "$inuse" | grep -qx "$b" && { echo "IN-WORKTREE $b"; continue; }
  if [ "$(git cherry origin/main "$b" | grep -c "^+")" = 0 ]; then echo "ON-MAIN $b"
  elif [ -n "$(git for-each-ref --contains "$b" --format=x refs/remotes/origin | head -1)" ]; then echo "ON-GITHUB $b"
  else echo "LOCAL-ONLY $b $(git log -1 --format=%cr "$b")"; fi
done | sort'
```

For each worktree, check `git -C <path> status --porcelain` and inspect the dirty file list. Lockfile churn and build output (`dist/`, `target/`, `build-desktop/`, `node_modules/`) are throwaway; modified source or unique untracked files are real work. Detached-HEAD worktrees have no branch line; test their tip as you would a branch.

Also check the main checkout itself. If local `main` has commits `origin/main` lacks, or uncommitted changes, back them up to `backup/<date>/local-main` before moving `main` to `origin/main` with `git branch -f main origin/main` from another branch.

## Decide per worktree and branch

```txt
covered + clean                 -> reap: git worktree remove <path>; git branch -D <branch>
covered + throwaway dirt only   -> reap: git worktree remove --force <path>; git branch -D <branch>
covered + REAL uncommitted work -> commit it to a branch, back that branch up, then reap
local-only + abandoned          -> back up, verify the SHA, then reap
local-only + in use             -> leave alone (active work)
checked out by a live session   -> leave alone, whatever its state
```

`-D` is justified by the coverage proof: `git branch -d` checks only the current `HEAD`, so it refuses branches that reached `main` under new hashes or that only a backup covers.

Keep a branch that another live session started from (such as a `base/*` ref) until that session's PR merges.

## Reaping is destructive: gate it

`git worktree remove`, `git branch -D`, and deleting remote branches are destructive (AGENTS.md: destructive actions need approval). For a sweep, present the exact backups and deletions, grouped by tier, before running any of them. Never reap on a self-reported "it's merged" or "it's backed up"; run the audit yourself.

- `git worktree remove` can fail with `Directory not empty` when ignored files remain. It still de-registers the worktree. Finish with `git worktree prune` then `rm -rf <path>`.
- The harnesses spawn and switch worktrees continuously, even mid-sweep: a worktree you audited may be on a different branch by the time you remove it. Re-check `git worktree list` immediately before each removal, and re-run the audit at the end.
- A remote branch whose PR merged can be deleted from GitHub too. Keep `backup/*` branches.
- An open PR whose content already reached `main` under other hashes should be closed with a comment naming the commit that landed it.

## Repo-specific worktree gotchas

- **`git stash` is shared across all worktrees here.** A bare `git stash`/`stash pop` can grab another worktree's entry. Prefer explicit branches; avoid stash.
- **Animal-named warp branches are stacked on unmerged bases**, cut from whatever was checked out rather than clean `origin/main`. Before opening a PR from one, run `git diff --stat origin/main...HEAD` and confirm scope; unrelated work rides along otherwise.
- **Verify HEAD before committing in a worktree** (`git rev-parse --abbrev-ref HEAD`). A handoff may claim a "fresh worktree on branch X" that does not exist; these stay checked out on the base branch itself.

## Invariant: one owner per worktree

Each worktree and branch has a single owner (the harness or agent that created it). Do not reap, back up, or commit into a worktree you do not own without confirming it is abandoned; a clean-looking tree may belong to a live session. When two sessions are sweeping at once, agree on who removes what before either deletes anything.

## Final checks

1. Re-run the audit: no `LOCAL-ONLY` branch should remain unless it is in use.
2. `git worktree list` shows only live worktrees; `git worktree prune` clears stale registrations.
3. Local `main` equals `origin/main` (`git rev-list --left-right --count origin/main...main` prints `0 0`).
