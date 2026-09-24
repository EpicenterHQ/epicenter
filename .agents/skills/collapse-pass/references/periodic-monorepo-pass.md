# Periodic Epicenter Monorepo Collapse Pass

Use this profile when the user wants a repeatable cleanup campaign across the
Epicenter monorepo, not a one-off refactor in a single package.

This file does not replace the collapse-pass ritual. It pins the standard scope,
stop conditions, validation expectations, and report shape for periodic runs.

## Contents

- [When to Run](#when-to-run)
- [Standard Scope](#standard-scope)
- [Required Context](#required-context)
- [Checkpoint Loop](#checkpoint-loop)
- [Pause Conditions](#pause-conditions)
- [Stop Conditions](#stop-conditions)
- [Final Report](#final-report)
- [Copy-Paste Goal](#copy-paste-goal)

## When to Run

Run this pass after a large feature wave, before a release branch, or when the
codebase has accumulated new exported surfaces. Do not run it as a background
habit while feature work is unstable.

The pass is valuable when the likely wins are:

- dead exports
- one-call helpers
- one-line forwarding wrappers
- stale wrapper modules
- duplicate barrel exports
- copied local types
- single-method `Pick` dependencies
- unnecessary casts inside typed code
- hidden JSDoc on returned factory methods
- names that describe old behavior
- private implementation types that are exported for no caller

## Standard Scope

Default in-scope targets:

```txt
apps/honeycrisp
apps/whispering
apps/local-mail
apps/api
packages/app
shared TypeScript utilities
```

Default exclusions:

```txt
generated files
migrations
durable data schemas
storage formats
durable strings from never-touch.md
unrelated specs
dependency changes
UI copy changes
public package boundary changes
externally plausible exports
```

Read directly imported specs or docs when a target imports or cites them. Do not
clean unrelated planning documents as part of the pass.

## Required Context

Before editing, read:

```txt
AGENTS.md
.agents/skills/collapse-pass/SKILL.md
.agents/skills/code-audit/SKILL.md
.agents/skills/typescript/SKILL.md
.agents/skills/refactoring/SKILL.md
.agents/skills/method-shorthand-jsdoc/SKILL.md
.agents/skills/one-sentence-test/SKILL.md
.agents/skills/post-implementation-review/SKILL.md
.agents/skills/collapse-pass/references/never-touch.md
.agents/skills/collapse-pass/references/smell-catalog.md
.agents/skills/collapse-pass/references/report-format.md
```

If a named skill is unavailable, say so and continue with the best local
fallback.

## Checkpoint Loop

For each checkpoint:

1. Pick one highest-confidence target file or symbol family.
2. Count callers with `rg`. Separate production callers from tests when that
   distinction matters.
3. Mentally inline helpers, wrappers, components, props, and types into call
   sites.
4. Run the one-sentence cohesion test.
5. Surface the finding before editing in the collapse-pass format.
6. Apply only changes that pass the anti-cosmetic gate.
7. Re-read every touched file.
8. Re-grep removed, renamed, or privatized symbols.
9. Run the narrowest relevant `bun test` or `bun run typecheck`.
10. Make one surgical conventional commit per logical simplification.

Acceptable outcomes per checkpoint:

```txt
genuine deletion      code, file, export, or wrapper disappeared
privatization         exported surface became a local implementation detail
inlining              a one-call hop disappeared and behavior stayed at caller
file collapse         a file stopped existing because its only job moved home
```

If validation is blocked by pre-existing failures, record the exact blocker and
keep the checkpoint scoped. Do not use unrelated failures as permission to skip
re-reading or re-grepping.

## Pause Conditions

Pause and ask before:

- behavior changes
- public API breaks
- storage or schema changes
- migration edits
- durable string changes
- UI copy changes
- dependency changes
- package boundary moves
- deleting an export with plausible external SDK consumers
- changing a function signature that crosses a published package boundary
- anything that cannot be validated locally enough to distinguish pass risk
  from pre-existing failure

## Stop Conditions

Stop when any condition is met:

```txt
12 meaningful checkpoints are committed
3 consecutive inspected targets produce no actionable findings
remaining findings require product, API, or storage decisions
a validation regression appears that cannot be fixed in one follow-up commit
```

If the user asks for a smaller pass, use 8 checkpoints.

## Final Report

Use `references/report-format.md`, plus one extra classification section:

```txt
Implementation classification
  Genuine deletion: <commits>
  Privatization: <commits>
  Inlining: <commits>
  File removal: <commits>
```

Always include:

```txt
commits landed
one-sentence rationale per commit
findings deferred
surface delta
file count delta
tests run
rejected smells
git status --short
```

Name pre-existing validation failures separately from failures introduced by the
pass.

## Copy-Paste Goal

```txt
/goal Run the periodic Epicenter monorepo collapse pass from `.agents/skills/collapse-pass/references/periodic-monorepo-pass.md` until 12 meaningful cleanup checkpoints are committed, 3 consecutive inspected targets produce no actionable findings, or remaining findings require product/API/storage decisions. First read the required context listed in that profile. For each checkpoint, count callers with `rg`, mentally inline the target, run the one-sentence cohesion test, surface the finding before editing, apply only anti-cosmetic simplifications, re-read touched files, re-grep removed or privatized symbols, run the narrowest relevant `bun test` or `bun run typecheck`, and make one surgical conventional commit. Pause before behavior changes, public API breaks, storage or schema changes, durable string changes, UI copy changes, dependency changes, package boundary moves, externally plausible export deletions, or anything that cannot be validated locally. Stop with the profile's evidence report, including genuine deletion vs privatization vs inlining, and leave unrelated worktree changes unstaged.
```
