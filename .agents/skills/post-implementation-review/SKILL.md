---
name: post-implementation-review
description: Review the combined implementation for correctness, clear ownership, and unnecessary complexity. Use when finishing substantial code implementation or refactoring, reviewing changes across callers or public APIs, or asked for a second pass or final sweep. Small edits need proportionate checks; independent architectural review belongs to adversarial-review.
metadata:
  author: epicenter
  version: '1.0'
---

# Post-implementation review

Review the result of the whole task, including earlier implementation waves and
the unchanged callers needed to understand it. Implementation can reveal an
owner or invariant that makes several local repairs unnecessary. Check that
combined shape before handing it back.

The current agent performs this review. It does not launch another agent
automatically. Use
[adversarial-review](../adversarial-review/SKILL.md) when independent judgment is
requested or a selected workflow calls for it. If you are already a delegated
reviewer, apply these checks yourself and return findings without launching
more reviewers.

## Scope the review

Start with the requested outcome, the task-start baseline, and the cumulative
changes. Read the affected entrypoints, owners, callers, and relevant tests.
Follow connected evidence beyond the edited code when it reveals a better
shape for the combined result. Respect explicit user limits, and surface
changes to product direction that exceed the authorized outcome.

Scale the review to what changed. A small local correction needs caller and
behavior checks, not a subsystem inventory. A structural refactor needs enough
of the affected system to establish where its state and rules now belong.
Identify the files that support a finding; no fixed report layout is required.

Before accepting the final shape, replay the change as if designing it from
scratch. For a structural review, use the
[concept inventory](../collapse-pass/references/concept-inventory.md) to visibly
list the methods and concepts someone must understand and ask whether a simpler
model could do the same job.

## Inspect the combined result

Use the checks relevant to the change rather than treating each as a separate
mandatory pass:

- Trace the behavior from an entrypoint through its actual callers. Look for
  regressions, missing requirements, changed evaluation timing, receiver
  binding, caching, and snapshot semantics.
- Mentally inline helpers, wrappers, components, and aliases in the affected
  system, including relevant unchanged boundaries. Keep a boundary when it
  names non-obvious work, enforces a shared rule, owns a lifecycle, isolates
  unsafe input, preserves a consumer contract, or explains a long phase.
  Caller count and line count alone do not decide. See
  [refactoring methods](../collapse-pass/references/refactoring-methods.md) for
  caller evidence and safe inlining.
- Establish who owns runtime lifetime, durable state, unfinished input, and
  user-visible state. Look for mirrored state, repeated decisions, and rules
  checked downstream that an earlier owner could guarantee once. Name who
  preserves information before removing an owner or protection.
- Check the resulting API and file layout from a caller's perspective. Does
  each name describe current behavior? Is there one clear path? Did the change
  leave an obsolete export, forwarding layer, comment, test, or documentation
  claim? Distinguish a wrong name, wrong owner, and unnecessary boundary;
  they call for different repairs.

Do not remove necessary parsing or validation boundaries, real consumer
contracts, or repetition that costs less than the abstraction replacing it.
Retire an old API or compatibility path only after tracing its active callers
and stored data and establishing that the authorized replacement preserves
them or includes their migration.

## Act on findings

Explain consequential structural changes and their consequences before editing.
Summarize routine corrections afterward. Fix grounded correctness, invariant,
API, verification, and serious clarity issues within the authorized outcome.
A concern can merit repair even if an earlier commit introduced it; authorship
alone does not decide scope.

Explain meaningful scope expansion and the caller evidence connecting it to the
task before editing. Respect explicit file limits. Report speculative,
cosmetic, or taste-only cleanup rather than widening the task for it. Surface
changes to product direction, destructive actions, and unresolved ownership or
contract decisions that exceed existing authorization.

Preserve unrelated edits, stored data, and unfinished input. Fewer lines alone
do not justify an edit.

## Verify

Inspect actual callers and run checks appropriate to the changed behavior.
Search for removed or renamed symbols and stale imports, exports, tests, and
documentation.

Use the task-start baseline or an agreed review baseline to investigate
failures. Current HEAD may already include earlier task changes, so reproducing
there does not establish that a failure predates the task. Use a separate
checkout when needed to reproduce without disturbing the user's work. Report
unverified attribution as uncertain.

After repairs, reread the affected code and callers and verify what changed.
Repeat checks when a new edit, failure, or unresolved concern warrants it; do
not repeat completed checks merely to complete another named pass.

## Output shape

For findings, identify the file and line, observable consequence, and proposed
repair. For completed repairs, explain what changed, why it helped, and what
verified it. Include material limitations or unresolved decisions beside the
claim they affect.

Include a short scope statement describing what was reviewed and what remains
unverified, even when no issues were found. Show an API example or
before-and-after ownership or file layout when that helps the user judge a
structural change. An exhaustive file tree and a fixed set of report sections
are optional. If no grounded issues remain, say so without manufacturing
cleanup.

A review-only request returns findings and proposed repairs without edits.
