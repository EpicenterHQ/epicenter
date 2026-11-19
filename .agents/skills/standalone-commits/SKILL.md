---
name: standalone-commits
description: Split work into reviewable, auditable commits ordered by dependency. Use when planning commit waves, staging changes, or deciding whether a commit is too broad, tiny, incomplete, or hard to revert.
metadata:
  author: epicenter
  version: '1.0'
---

# Standalone Commits

A standalone commit is a commit a reviewer can audit on its own, at that point in branch history. It may depend on earlier commits in the same branch, but it should not require future commits to explain, compile, test, or justify it.

> **Related**: [pull-request](../pull-request/SKILL.md) for PR titles and bodies; commit format and worktree rules are in `AGENTS.md`, "Git hygiene".

## Two Halves: Boundary And Order

This skill owns both halves of commit shaping. Hold them at once:

- **The review boundary** (this file): is each commit worth reviewing by itself? That is the philosophy and the acceptance checks below.
- **The ordering**: what order should the standalone commits happen in? For the detailed dependency-ordered wave procedure, read [references/splitting-into-ordered-waves.md](references/splitting-into-ordered-waves.md).

Without ordering, "standalone" drifts into polished but poorly sequenced commits. Without the boundary checks, technically ordered commits can still be hard to review.

## The Standard

Each commit should answer one sentence:

> This commit changes `<thing>` so that `<outcome>` because `<reason>`.

If the sentence needs "and also", split the commit. If the reason only becomes true in a later commit, move the work later or combine the dependent pieces.

## Acceptance Checks

Before committing, verify the staged diff against these checks:

| Check | Question |
| --- | --- |
| Reviewable | Can a reviewer understand the purpose from this diff and message alone? |
| Buildable | Does the repo still typecheck, build, or pass the relevant focused test after this commit? |
| Complete | Are all call sites, exports, tests, docs, and fixtures needed for this concern included? |
| Focused | Is there exactly one behavioral, structural, or documentation concern? |
| Auditable | Can someone inspect the before/after and see the invariant being preserved or changed? |
| Revertible | If this commit were reverted, would it remove one coherent change without dragging in unrelated work? |

When a commit fails one check, fix the staged set before writing the message.

## What Standalone Means

Standalone does mean:

- The commit is coherent at its point in history.
- The message explains why the diff exists.
- New public surface has the minimum implementation, exports, and tests needed to be credible.
- Refactors preserve behavior and include verification when risk is non-trivial.
- Mechanical changes are separated from semantic changes when mixing them would hide behavior.

Standalone does not mean:

- Every commit must be useful without earlier commits in the same branch.
- Every commit must be tiny.
- A large generated or mechanical change must be manually split into noise.
- The final branch cannot contain dependency chains.

## Wave Planning

When ordering work into waves, plan each wave as a standalone commit:

```
Wave 1 claim: Add the type or contract, plus any tests that prove the new shape.
Wave 2 claim: Add the implementation that satisfies the contract.
Wave 3 claim: Move consumers onto the implementation.
Wave 4 claim: Remove old paths once no consumers depend on them.
```

Do not create a "setup" commit that only makes a future commit possible unless it is independently reviewable. A foundation commit is fine when it introduces a real contract, helper, migration, or test fixture with a clear reason.

Before coding a wave, write its claim. After staging it, re-read the staged diff and ask whether the claim is still honest. If not, split, combine, or move the work.

## Staging Workflow

1. Inspect the full diff.
2. Write the one-sentence commit claim.
3. Stage only files and hunks that prove that claim.
4. Re-read the staged diff with `git diff --staged`.
5. Run focused verification for that staged state when practical.
6. Commit with a message that names the outcome and explains the reason when needed.

Prefer file-level staging when files cleanly map to the commit claim. Use hunk staging when one file contains multiple concerns.

## Split Or Combine Heuristics

Split when:

- A refactor and behavior change appear together.
- A rename or move hides logic changes.
- Tests cover a different concern than the implementation.
- A dependency bump is mixed with feature work.
- Reviewers would need to hold two mental models at once.

Combine when:

- A type without its only implementation would be dead surface.
- A helper without its call site would be speculative.
- A test without the fix would intentionally fail in the branch.
- A migration without the schema or reader change would break local state.

## Anti-Patterns

### Teaser Commit

```
feat(sync): add workspace sync types
```

Problem: The types are unused, untested, and only make sense after a later implementation commit.

Better: Include the contract-level implementation or test that proves why the types exist.

### Hidden Behavior In Refactor

```
refactor(auth): reorganize session helpers
```

Problem: The diff also changes session expiry behavior. Reviewers may scan it as a move-only change.

Better: Commit the move first with no behavior change, then commit the expiry behavior change with tests.

### Cleanup Hitchhiker

```
fix(settings): persist provider selection
```

Problem: The commit also renames unrelated variables and formats nearby files.

Better: Keep the fix focused. Put cleanup in a separate commit only if it is worth reviewing.

## Commit Message Shape

Make the subject name the outcome, not the implementation detail.

Good:

```
fix(settings): persist selected provider across reloads
```

Weak:

```
fix(settings): update localStorage call
```

Add a body when the reason, invariant, or review boundary is not obvious from the diff.
