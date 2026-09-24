---
name: collapse-pass
description: Remove indirection that does not earn its boundary across a diff or package. Use when the user asks to run a collapse pass, simplify this broadly, audit dead abstractions, or shrink a surface, not when one function’s branching is the target.
metadata:
  author: epicenter
  version: '1.0'
---

# Collapse Pass

A collapse pass is a session-long sequence of small commits that each delete one piece of indirection. Every commit must shrink the public surface, the file count, the call-graph depth, or the first-read effort. If a commit moves none of those needles, revert it and find a deeper smell.

> **Related skills**: [code-audit](../code-audit/SKILL.md) lists the codebase-specific smell categories with grep patterns. [refactoring](../refactoring/SKILL.md) owns the per-change mechanics (caller counting, inlining, surgical commits). [one-sentence-test](../one-sentence-test/SKILL.md) is the cohesion gate for each candidate file. [rethink](../rethink/SKILL.md) covers the deeper redesigns when a collapse won't fit in one commit. [post-implementation-review](../post-implementation-review/SKILL.md) is the second-read protocol after each commit, and its first-read pass checks the diff from a stranger's perspective.

## References

Load on demand:

- Before any edit, read [references/never-touch.md](references/never-touch.md). It names the durable strings, schemas, and shapes you must not change without surfacing first, plus the pause list.
- For the grep cookbook with calibrated patterns, read [references/smell-catalog.md](references/smell-catalog.md).
- For the operating principle that decides hard cases, read [references/library-refusal.md](references/library-refusal.md).
- For the per-checkpoint surface format and the stop-time final report shape, read [references/report-format.md](references/report-format.md).
- For a thin `/goal` template that invokes this skill, read [references/goal-template.md](references/goal-template.md).
- For Epicenter's repeatable monorepo maintenance pass, read [references/periodic-monorepo-pass.md](references/periodic-monorepo-pass.md).

## Operating principle

When a library refuses your model, treat the refusal as information about the model, not as friction to route around. If a "simplification" requires reimplementing a library's public surface, stop and delete the model instead.

When preserving a promise keeps a second system alive, run
[asymmetric-wins](../asymmetric-wins/SKILL.md). A collapse pass may sacrifice a
small amount of fidelity, compatibility, reproducibility, or rare-mode support
when the product sentence survives and the deletion removes a disproportionate
implementation family. Name the refused promise before editing.

## Per-iteration ritual

For each candidate file or symbol family:

1. **Pick one target.** Count non-test callers exactly with `rg`. If zero, the candidate is a dead-export collapse. If one, it's an inline-the-helper collapse. If many, find a narrower target.
2. **Mentally inline** every helper, wrapper, prop, and indirection layer into its callers. Read the inlined result as a stranger would.
3. **Run the one-sentence test** on the file. Write one concrete sentence describing what it does today. If the sentence drifts or grows "or" clauses, name the ambiguity; that ambiguity is usually the smell.
4. **Surface the finding BEFORE editing**, in this exact shape:

   ```
   Finding N: <smell>
   Inline check: <what mental inlining showed>
   Fix: <proposed change>
   What stays the same: <visible behavior, durable strings, blob layout>
   ```

5. **Apply mechanical, low-risk findings only.** For each:
   - `bun test` on impacted packages
   - `bun run typecheck` on impacted packages
   - One conventional-commit per logical simplification, citing `file:line` and naming what collapsed
6. **Re-grep the removed/renamed symbol.** Sweep stragglers (stale JSDoc, dead re-exports, orphaned imports) in a follow-up `chore: straggler sweep` commit.
7. **Move to the next file.**

## The anti-cosmetic gate

After each commit, at least one must be true:

- Public API surface shrank (one fewer exported name)
- File count shrank (single-function file folded into its caller)
- Call-graph depth shrank (one indirection layer removed)
- A future first-read got measurably easier

If none is true, the change was cosmetic. Revert and find a deeper smell.

## Implementation Gate

When a collapse pass follows a fresh implementation, do not limit the review to
symbols that existed before the change. New code is often the easiest place to
remove indirection. Check every new helper, component, wrapper, prop callback,
options object, and file split before declaring the implementation done.

Use this quick table before staging:

```txt
boundary             callers  earns itself by
WidgetHost           1        owns resource and widget lifetime
WidgetView           1        no, only passes a stable handle
```

One-caller boundaries can stay when they isolate a lifecycle, unsafe boundary,
public contract, or long imperative phase. They should collapse when they only
pass through stable handles, callbacks, or values that the caller already owns.

## Pause and surface to the user

Stop and ask before:

- Changing any string from `references/never-touch.md`
- Deleting a public exported name with zero in-repo callers but plausible external CLI/SDK consumers
- Collapsing two files where one's JSDoc documents a non-obvious invariant
- Merging packages or moving exports across package boundaries
- Changing a function signature that crosses a published package boundary

## Stop conditions

Stop when any of the following is true:

- Three consecutive files yield no findings
- Remaining findings all require product input (renaming a public capability, splitting a package, adding a tenant axis)
- A typecheck or test regression cannot be resolved in one follow-up commit
- A configured checkpoint budget is reached (e.g. 8 checkpoints)

At stop, deliver the final report from [references/report-format.md](references/report-format.md).

## Pass parameters worth declaring

A goal that invokes this skill should say:

- **Scope**: which packages and which apps
- **Stop condition**: "three no-finding files" or "N checkpoints" or "queue empty"
- **Citation requirement**: whether library refusals must be backed by a deepwiki citation against the upstream repo
- **Starting target**: usually the narrowest surface first (e.g. `packages/auth` before `apps/api`)

Everything else (the ritual, gate, finding format, never-touch list, report shape) is in this skill.

## On a PR or branch diff

When the target is a pull request, a branch, or a recent merged change rather
than a working package, the ritual above is unchanged; only the scoping differs.

1. Isolate the change in a worktree by default. Do not reset the user's active
   checkout.

   ```bash
   # GitHub PR number
   git fetch origin pull/<number>/head:pr-<number>-collapse
   git worktree add ../epicenter-pr-<number>-collapse pr-<number>-collapse
   # or a named branch (slug: replace slashes with hyphens)
   git fetch origin <branch>:<branch>-collapse
   git worktree add ../epicenter-<branch-slug>-collapse <branch>-collapse
   ```

2. Compute scope with `git diff --name-only <base>...HEAD`. Infer the base from
   PR metadata, the upstream tracking branch, or `origin/main`, in that order.
3. Read changed files first, then direct callers and tests. Run the
   per-iteration ritual and anti-cosmetic gate exactly as above. List every file
   read as an ASCII tree before analysis.
4. Do not stage, commit, push, or open a PR unless the user asks. Do not leave
   the worktree dirty without reporting its path and state.
5. Finish with [post-implementation-review](../post-implementation-review/SKILL.md)
   and targeted `bun test` / `bun run typecheck` on impacted packages.

When the user asks for an outside review prompt, use
[handoff](../handoff/SKILL.md) to draft one bounded question with the exact diff
or file paths the reviewer needs.
